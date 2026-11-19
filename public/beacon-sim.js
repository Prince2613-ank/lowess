/* ==========================================================================
 * BLE beacon signal simulation and indoor positioning.
 *
 * Loads frontend/data/beacons/<store>.json (scripts/build_beacons.py): the
 * store's illustrative beacons, signal model and zone grid, on the store's
 * walking grid (IndoorRouting.Network). Everything is in grid metres (the
 * network's local projection); the browser aligns results like the map.
 *
 *   SignalModel   - what a receiver hears from each beacon each scan: log-
 *                   distance path loss over the 3D distance to a ceiling
 *                   beacon, shelving on the receiver's side of the path, the
 *                   beacon's own measured-power spread, slow shadowing (it
 *                   decorrelates as the receiver moves) and scan noise.
 *                   Weaker than the receiver's sensitivity: not heard.
 *   ParticleFilter - the position a real system would report from those
 *                   readings alone: particles on the walkable floor, moved
 *                   by a walking-motion model and weighted by how well the
 *                   expected signal explains the RSSI - from the calibrated
 *                   radio map (what a site survey measures per cell) or,
 *                   uncalibrated, from nominal path loss only. Gives the
 *                   estimate, its accuracy (68% circle) and a confidence
 *                   class. No GPS: indoors there is none.
 * No DOM or map code here.
 * ========================================================================== */

const BeaconSim = (() => {
    const PARTICLES = 300;
    const LIKELIHOOD_SIGMA_DB = 5;     // spread of readings around the expected signal (shadowing, noise, model error)
    const WEAK_SIGMA_DB = 8;           // readings below the usable level: heard, but only loosely trusted
    const EXPECTED_SHELVING_DB = 2;    // average shelving loss the estimator allows for
    const WALK_SIGMA_M = 0.5;          // motion noise per scan, plus up to MAX_SPEED_MPS of walking
    const MAX_SPEED_MPS = 1.6;
    const SHADOW_DECORRELATION_M = 3;  // shadowing changes over a few metres of movement
    const RESET_SHARE = 0.03;          // particles re-drawn near the strongest beacon every scan
    // Reported accuracy: radius of the circle holding the true position ~68% of
    // the time (as a phone's blue circle) - the particles' spread (DRMS) scaled
    // to that, per positioning mode, measured against the simulated truth on
    // walks between random racks in five stores (calibrated: median error
    // 3-4 m; uncalibrated: 5-8 m).
    const ACCURACY_SCALE = { calibrated: 1.45, nominal: 1.5 };
    const CONFIDENCE = { high: 4, medium: 8 };    // m: accuracy limits of the classes

    // Small seeded generator so a store's simulation is repeatable.
    function mulberry32(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seedOf(text) {
        let hash = 2166136261;
        for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return hash >>> 0;
    }

    function gaussian(random) {
        const u = Math.max(1e-12, random()), v = random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /* -- floor: walking grid in metres, zones ------------------------------ */

    class Floor {
        constructor(network, payload) {
            this.network = network;
            Object.assign(this, { cols: network.cols, rows: network.rows, cell: network.cell, x0: network.x0, y0: network.y0 });
            this.walkable = network.walkable;
            this.projection = network.projection;
            this.zoneLabels = payload.zones?.labels || ["Main aisles"];
            this.zoneIndex = new Uint8Array(this.cols * this.rows);
            const runs = payload.zones?.cells || [];
            for (let i = 0, at = 0; i + 1 < runs.length; i += 2) {
                this.zoneIndex.fill(runs[i], at, at + runs[i + 1]);
                at += runs[i + 1];
            }
        }

        cellXY(cell) {
            const r = Math.floor(cell / this.cols), c = cell - r * this.cols;
            return [this.x0 + (c + 0.5) * this.cell, this.y0 + (r + 0.5) * this.cell];
        }

        cellAt(x, y) {
            const c = Math.floor((x - this.x0) / this.cell), r = Math.floor((y - this.y0) / this.cell);
            return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
        }

        isWalkable(x, y) {
            const cell = this.cellAt(x, y);
            return cell >= 0 && this.walkable[cell] === 1;
        }

        // Nearest walkable cell centre to (x, y), searching outwards up to `reach` cells.
        snap(x, y, reach = 16) {
            if (this.isWalkable(x, y)) return [x, y];
            const c0 = Math.floor((x - this.x0) / this.cell), r0 = Math.floor((y - this.y0) / this.cell);
            let best = null, bestD = Infinity;
            for (let ring = 1; ring <= reach && !best; ring += 1) {
                for (let dr = -ring; dr <= ring; dr += 1) {
                    for (let dc = -ring; dc <= ring; dc += 1) {
                        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
                        const r = r0 + dr, c = c0 + dc;
                        if (r < 0 || c < 0 || r >= this.rows || c >= this.cols || !this.walkable[r * this.cols + c]) continue;
                        const [px, py] = this.cellXY(r * this.cols + c);
                        const d = Math.hypot(px - x, py - y);
                        if (d < bestD) { bestD = d; best = [px, py]; }
                    }
                }
            }
            return best || [x, y];
        }

        zoneAt(x, y) {
            const cell = this.cellAt(x, y);
            return this.zoneLabels[cell >= 0 ? this.zoneIndex[cell] : 0] || this.zoneLabels[0];
        }

        toSource(x, y) {
            const p = this.projection;
            return [p.lon0 + x / p.kx, p.lat0 + y / p.ky];
        }

        fromSource([lon, lat]) {
            const p = this.projection;
            return [(lon - p.lon0) * p.kx, (lat - p.lat0) * p.ky];
        }

        // Metres of blocked grid on the line from (x, y) towards (bx, by), over its first `reach`.
        blockedMetres(x, y, bx, by, reach) {
            const length = Math.hypot(bx - x, by - y) * reach;
            const samples = Math.max(2, Math.ceil(length / this.cell) + 1);
            let blocked = 0;
            for (let i = 0; i < samples; i += 1) {
                const t = (reach * i) / (samples - 1);
                const cell = this.cellAt(x + (bx - x) * t, y + (by - y) * t);
                if (cell >= 0 && !this.walkable[cell]) blocked += 1;
            }
            return (blocked / samples) * length;
        }
    }

    /* -- signals ------------------------------------------------------------ */

    class SignalModel {
        constructor(floor, payload, random) {
            this.floor = floor;
            this.model = payload.model;
            this.random = random;
            const m = this.model;
            this.drop = m.mount_height_m - m.receiver_height_m;
            this.reach = (m.shelving_height_m - m.receiver_height_m) / this.drop;
            // Adverts in one scan window, averaged by the receiver (noise falls with their count).
            this.adverts = Math.max(1, Math.round((m.scan_interval_s * 1000) / m.advertising_interval_ms));
            this.calibrated = true;
            this.radioMap = new Map();   // beacon id -> Float32Array of surveyed signal per cell (lazy)
            this.beacons = payload.beacons.map((beacon) => {
                const [x, y] = floor.fromSource(beacon.position);
                return { ...beacon, x, y };
            });
        }

        // Path loss over the 3D distance for a horizontal distance (no shelving).
        pathLoss(horizontal) {
            return 10 * this.model.path_loss_exponent * Math.log10(Math.hypot(horizontal, this.drop));
        }

        // True mean signal at (x, y): the beacon's actual measured power, path loss, shelving.
        mean(beacon, x, y) {
            const m = this.model;
            const shelving = Math.min(m.shelving_cap_db, this.floor.blockedMetres(x, y, beacon.x, beacon.y, this.reach) * m.shelving_db_per_m);
            return beacon.tx_power_dbm + (beacon.tx_offset_db || 0) - this.pathLoss(Math.hypot(beacon.x - x, beacon.y - y)) - shelving;
        }

        // What the positioning engine expects to hear at (x, y). Calibrated: the
        // surveyed radio map (mean signal per cell, as a site survey measures it);
        // otherwise nominal values only (no shelving map, no per-beacon power).
        expected(beacon, x, y) {
            if (!this.calibrated) return beacon.tx_power_dbm - this.pathLoss(Math.hypot(beacon.x - x, beacon.y - y)) - EXPECTED_SHELVING_DB;
            const cell = this.floor.cellAt(x, y);
            if (cell < 0) return this.mean(beacon, x, y);
            let map = this.radioMap.get(beacon.id);
            if (!map) { map = new Float32Array(this.floor.cols * this.floor.rows).fill(NaN); this.radioMap.set(beacon.id, map); }
            if (Number.isNaN(map[cell])) {
                const [cx, cy] = this.floor.cellXY(cell);
                map[cell] = this.mean(beacon, cx, cy);
            }
            return map[cell];
        }

        // Horizontal distance the nominal model gives for a signal strength.
        distanceFor(rssi, beacon) {
            const d3 = 10 ** ((beacon.tx_power_dbm - EXPECTED_SHELVING_DB - rssi) / (10 * this.model.path_loss_exponent));
            return Math.sqrt(Math.max(0, d3 * d3 - this.drop * this.drop));
        }

        // One scan by a receiver at (x, y). `state` keeps its shadowing per beacon.
        scan(state, x, y) {
            const m = this.model;
            const moved = state.at ? Math.hypot(x - state.at[0], y - state.at[1]) : Infinity;
            const rho = Number.isFinite(moved) ? Math.exp(-moved / SHADOW_DECORRELATION_M) : 0;
            state.at = [x, y];
            state.shadow = state.shadow || new Map();
            const readings = [];
            for (const beacon of this.beacons) {
                const previous = state.shadow.get(beacon.id);
                const fresh = gaussian(this.random) * m.shadowing_sigma_db;
                const shadow = previous == null ? fresh : rho * previous + Math.sqrt(1 - rho * rho) * fresh;
                state.shadow.set(beacon.id, shadow);
                const rssi = Math.round(this.mean(beacon, x, y) + shadow + gaussian(this.random) * m.noise_sigma_db / Math.sqrt(this.adverts));
                if (rssi >= m.sensitivity_dbm) readings.push({ beacon, rssi });
            }
            return readings.sort((a, b) => b.rssi - a.rssi);
        }
    }

    /* -- positioning -------------------------------------------------------- */

    class ParticleFilter {
        constructor(floor, signal, random, count = PARTICLES) {
            Object.assign(this, { floor, signal, random, count });
            this.x = new Float64Array(count);
            this.y = new Float64Array(count);
            this.w = new Float64Array(count).fill(1 / count);
            this.ready = false;
            this.estimate = null;
        }

        // A walkable point near a beacon, about as far as its signal suggests.
        nearBeacon(reading) {
            const { beacon, rssi } = reading;
            const radius = Math.max(4, 1.5 * this.signal.distanceFor(rssi, beacon));
            for (let tries = 0; tries < 40; tries += 1) {
                const angle = this.random() * 2 * Math.PI, r = radius * Math.sqrt(this.random());
                const x = beacon.x + Math.cos(angle) * r, y = beacon.y + Math.sin(angle) * r;
                if (this.floor.isWalkable(x, y)) return [x, y];
            }
            return this.floor.snap(beacon.x, beacon.y);
        }

        reset(strongest) {
            for (let i = 0; i < this.count; i += 1) [this.x[i], this.y[i]] = this.nearBeacon(strongest);
            this.w.fill(1 / this.count);
            this.ready = true;
        }

        /**
         * One scan's readings (strongest first) after `dt` seconds.
         * Returns { x, y, accuracy, heard, confidence } in grid metres.
         */
        update(readings, dt) {
            const usable = readings.filter((reading) => reading.rssi >= this.signal.model.usable_dbm);
            if (!usable.length) {
                // Nothing to position from: hold the last estimate, less and less sure of it.
                if (this.estimate) {
                    this.estimate = { ...this.estimate, accuracy: this.estimate.accuracy + MAX_SPEED_MPS * dt, heard: 0, confidence: "lost" };
                }
                return this.estimate;
            }
            if (!this.ready) this.reset(usable[0]);
            const { x, y, w, count, floor, signal, random } = this;
            // Motion: anyone may have walked up to MAX_SPEED_MPS since the last scan.
            const sigma = WALK_SIGMA_M + MAX_SPEED_MPS * dt * 0.6;
            for (let i = 0; i < count; i += 1) {
                const nx = x[i] + gaussian(random) * sigma, ny = y[i] + gaussian(random) * sigma;
                if (floor.isWalkable(nx, ny)) { x[i] = nx; y[i] = ny; }
            }
            // Sensor resetting: a few particles near the strongest beacon keep the filter from getting lost.
            const resets = Math.max(1, Math.round(count * RESET_SHARE));
            for (let k = 0; k < resets; k += 1) {
                const i = Math.floor(random() * count);
                [x[i], y[i]] = this.nearBeacon(usable[0]);
            }
            // Weights: how well the expected signal explains every reading - usable ones
            // fully, weak ones loosely - and every beacon that should be heard but is not.
            const { usable_dbm: usableDbm, sensitivity_dbm: sensitivity } = signal.model;
            // Uncalibrated, only usable readings are trusted: without a survey the engine
            // cannot tell a weak or missing signal from one blocked by shelving.
            const heard = new Map((signal.calibrated ? readings : usable).map((reading) => [reading.beacon.id, reading.rssi]));
            const trusted = signal.calibrated ? signal.beacons : usable.map((reading) => reading.beacon);
            const logs = new Float64Array(count);
            let maxLog = -Infinity;
            for (let i = 0; i < count; i += 1) {
                let log = Math.log(w[i] || 1e-300);
                for (const beacon of trusted) {
                    const expected = signal.expected(beacon, x[i], y[i]);
                    const rssi = heard.get(beacon.id);
                    let z = 0;
                    if (rssi == null) z = Math.max(0, expected - sensitivity) / LIKELIHOOD_SIGMA_DB;
                    else z = (rssi - expected) / (rssi >= usableDbm ? LIKELIHOOD_SIGMA_DB : WEAK_SIGMA_DB);
                    log -= 0.5 * z * z;
                }
                logs[i] = log;
                if (log > maxLog) maxLog = log;
            }
            let sum = 0;
            for (let i = 0; i < count; i += 1) { w[i] = Math.exp(logs[i] - maxLog); sum += w[i]; }
            let ess = 0;
            for (let i = 0; i < count; i += 1) { w[i] /= sum; ess += w[i] * w[i]; }
            if (1 / ess < count / 2) this.resample();
            // Estimate: weighted mean on the walkable floor; accuracy: spread of the particles (DRMS).
            let mx = 0, my = 0;
            for (let i = 0; i < count; i += 1) { mx += w[i] * x[i]; my += w[i] * y[i]; }
            let vx = 0, vy = 0;
            for (let i = 0; i < count; i += 1) { vx += w[i] * (x[i] - mx) ** 2; vy += w[i] * (y[i] - my) ** 2; }
            const [ex, ey] = floor.snap(mx, my);
            const accuracy = Math.max(1, ACCURACY_SCALE[signal.calibrated ? "calibrated" : "nominal"] * Math.sqrt(vx + vy));
            const confidence = accuracy <= CONFIDENCE.high && usable.length >= 3 ? "high" : accuracy <= CONFIDENCE.medium && usable.length >= 2 ? "medium" : "low";
            this.estimate = { x: ex, y: ey, accuracy, heard: usable.length, confidence };
            return this.estimate;
        }

        // Systematic resampling, with a little jitter so copies spread out again.
        resample() {
            const { x, y, w, count, random, floor } = this;
            const nx = new Float64Array(count), ny = new Float64Array(count);
            const step = 1 / count;
            let target = random() * step, cumulative = w[0], j = 0;
            for (let i = 0; i < count; i += 1) {
                while (target > cumulative && j < count - 1) { j += 1; cumulative += w[j]; }
                const jx = x[j] + gaussian(random) * 0.2, jy = y[j] + gaussian(random) * 0.2;
                if (floor.isWalkable(jx, jy)) { nx[i] = jx; ny[i] = jy; } else { nx[i] = x[j]; ny[i] = y[j]; }
                target += step;
            }
            x.set(nx); y.set(ny);
            w.fill(1 / count);
        }
    }

    async function load(storeId) {
        const response = await fetch(`data/beacons/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const payload = await response.json();
        if (!Array.isArray(payload.beacons) || !payload.model) throw new Error("Malformed beacon data");
        return payload;
    }

    return { Floor, SignalModel, ParticleFilter, mulberry32, seedOf, gaussian, load, CONFIDENCE };
})();

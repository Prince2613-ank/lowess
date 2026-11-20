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
 *   Rack beacons - a low-power beacon on each rack face, heard strongly only
 *                   from close by. The strongest few weigh in the particle
 *                   filter alongside the ceiling beacons (position under 1 m
 *                   along the racks), and name the rack someone stands at.
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
    // walks between random racks in the stores (~30 beacons a store; calibrated:
    // median error ~2 m; uncalibrated: ~4 m).
    const ACCURACY_SCALE = { calibrated: 1.3, nominal: 1.5, rack: 0.72 };
    const CONFIDENCE = { high: 3, medium: 6 };    // m: rack level, aisle level
    const RACK_SHADOW_DECORRELATION_M = 1.5;
    const RACK_LIKELIHOOD_SIGMA_DB = 3;  // rack readings: short range, little fading
    const RACK_READINGS_USED = 6;        // strongest rack beacons weighed per scan
    const RACK_USED_BELOW_FIX_DB = 8;    // ...if within this of the rack-fix level (~5 m)
    const RACK_BUCKET_M = 4;           // spatial index cell for the rack beacons

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
            this.radioMaps = [];         // per beacon: Float32Array of surveyed signal per cell (filled lazily)
            this.beacons = payload.beacons.map((beacon, index) => {
                const [x, y] = floor.fromSource(beacon.position);
                return { ...beacon, x, y, index };
            });
            // Rack beacons: [rack_id, x, y] on the rack face; (px, py) is the rack's pick point.
            this.rackModel = payload.rack_model || null;
            this.rackAdverts = this.rackModel ? Math.max(1, Math.round((m.scan_interval_s * 1000) / this.rackModel.advertising_interval_ms)) : 1;
            this.rackBeacons = [];
            this.rackIndex = new Map();
            this.rackCache = new Map();          // expected rack-beacon signal per (beacon, cell)
            this.rackCacheNominal = new Map();
            for (const [rackId, x, y] of payload.rack_beacons || []) {
                const cell = floor.network.rackAccess[rackId];
                if (cell == null) continue;
                const [px, py] = floor.cellXY(cell);
                const beacon = { rackId, x, y, px, py, index: this.rackBeacons.length };
                this.rackBeacons.push(beacon);
                const key = `${Math.floor(x / RACK_BUCKET_M)},${Math.floor(y / RACK_BUCKET_M)}`;
                if (!this.rackIndex.has(key)) this.rackIndex.set(key, []);
                this.rackIndex.get(key).push(beacon);
            }
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
            return this.expectedAt(beacon, this.floor.cellAt(x, y), x, y);
        }

        // As expected(), for a point whose grid cell is already known (the filter's hot loop).
        expectedAt(beacon, cell, x, y) {
            if (!this.calibrated) return beacon.tx_power_dbm - this.pathLoss(Math.hypot(beacon.x - x, beacon.y - y)) - EXPECTED_SHELVING_DB;
            if (cell < 0) return this.mean(beacon, x, y);
            let map = this.radioMaps[beacon.index];
            if (!map) map = this.radioMaps[beacon.index] = new Float32Array(this.floor.cols * this.floor.rows).fill(NaN);
            let value = map[cell];
            if (value !== value) {                           // NaN: not surveyed yet
                const [cx, cy] = this.floor.cellXY(cell);
                value = map[cell] = this.mean(beacon, cx, cy);
            }
            return value;
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

        // Rack beacons heard by a receiver at (x, y): [{ rack, rssi }], strongest first.
        scanRacks(state, x, y) {
            const rm = this.rackModel;
            if (!rm || !this.rackBeacons.length) return [];
            const moved = state.rackAt ? Math.hypot(x - state.rackAt[0], y - state.rackAt[1]) : Infinity;
            const rho = Number.isFinite(moved) ? Math.exp(-moved / RACK_SHADOW_DECORRELATION_M) : 0;
            state.rackAt = [x, y];
            const previousShadow = state.rackShadow || new Map();
            const shadows = new Map();
            const readings = [];
            const reach = rm.heard_within_m, span = Math.ceil(reach / RACK_BUCKET_M);
            const bx0 = Math.floor(x / RACK_BUCKET_M), by0 = Math.floor(y / RACK_BUCKET_M);
            for (let i = -span; i <= span; i += 1) {
                for (let j = -span; j <= span; j += 1) {
                    for (const beacon of this.rackIndex.get(`${bx0 + i},${by0 + j}`) || []) {
                        const d = Math.hypot(beacon.x - x, beacon.y - y);
                        if (d > reach) continue;
                        const length = Math.max(0.3, d);
                        // Other racks in the way (not the last half metre: the beacon sits on its own rack).
                        const through = length > 0.6 ? this.floor.blockedMetres(x, y, beacon.x, beacon.y, 1 - 0.5 / length) : 0;
                        const mean = rm.tx_power_dbm - 10 * rm.path_loss_exponent * Math.log10(length) - Math.min(rm.shelving_cap_db, through * rm.shelving_db_per_m);
                        const previous = previousShadow.get(beacon.rackId);
                        const fresh = gaussian(this.random) * rm.shadowing_sigma_db;
                        const shadow = previous == null ? fresh : rho * previous + Math.sqrt(1 - rho * rho) * fresh;
                        shadows.set(beacon.rackId, shadow);
                        const rssi = Math.round(mean + shadow + gaussian(this.random) * rm.noise_sigma_db / Math.sqrt(this.rackAdverts));
                        if (rssi >= this.model.sensitivity_dbm) readings.push({ rack: beacon, rssi });
                    }
                }
            }
            state.rackShadow = shadows;
            return readings.sort((a, b) => b.rssi - a.rssi);
        }

        // Expected signal from a rack beacon at (x, y): path loss, plus the racks in
        // between when calibrated (surveyed), as the engine assumes it.
        // Cached per beacon and grid cell (cell centre), like the ceiling radio map.
        rackExpected(beacon, x, y) {
            return this.rackExpectedAt(beacon, this.floor.cellAt(x, y), x, y);
        }

        rackExpectedAt(beacon, cell, x, y) {
            const key = beacon.index * this.floor.cols * this.floor.rows + cell;
            const cache = this.calibrated ? this.rackCache : this.rackCacheNominal;
            let value = cache.get(key);
            if (value === undefined) {
                const rm = this.rackModel;
                const [cx, cy] = cell >= 0 ? this.floor.cellXY(cell) : [x, y];
                const length = Math.max(0.3, Math.hypot(beacon.x - cx, beacon.y - cy));
                let loss = 10 * rm.path_loss_exponent * Math.log10(length);
                if (this.calibrated && length > 0.6) loss += Math.min(rm.shelving_cap_db, this.floor.blockedMetres(cx, cy, beacon.x, beacon.y, 1 - 0.5 / length) * rm.shelving_db_per_m);
                value = rm.tx_power_dbm - loss;
                cache.set(key, value);
            }
            return value;
        }

        // Rack-level fix from rack beacon readings, or null when no rack beacon is close.
        // The strongest few (within group_db of the best) share it: the weighted centre
        // of their pick points, so standing between two racks lands between them.
        rackFix(readings) {
            const rm = this.rackModel;
            const best = readings[0];
            if (!rm || !best || best.rssi < rm.fix_dbm) return null;
            const group = readings.filter((r) => r.rssi >= best.rssi - rm.group_db);
            let sw = 0, sx = 0, sy = 0;
            for (const { rack, rssi } of group) {
                const w = 10 ** ((rssi - best.rssi) / 10);
                sw += w; sx += w * rack.px; sy += w * rack.py;
            }
            const mx = sx / sw, my = sy / sw;
            let spread = 0;
            for (const { rack, rssi } of group) spread += 10 ** ((rssi - best.rssi) / 10) * ((rack.px - mx) ** 2 + (rack.py - my) ** 2);
            const [x, y] = this.floor.snap(mx, my);
            return { x, y, spread: Math.sqrt(spread / sw), rackId: best.rack.rackId, racks: group.map((r) => r.rack.rackId), rssi: best.rssi };
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

        // A walkable point within ~1.5 m of a rack beacon's pick point.
        nearRack(reading) {
            const { rack } = reading;
            for (let tries = 0; tries < 20; tries += 1) {
                const x = rack.px + gaussian(this.random) * 0.8, y = rack.py + gaussian(this.random) * 0.8;
                if (this.floor.isWalkable(x, y)) return [x, y];
            }
            return [rack.px, rack.py];
        }

        /**
         * One scan's readings (strongest first) after `dt` seconds, with the rack
         * beacon readings of the same scan.
         * Returns { x, y, accuracy, heard, racks, confidence, source } in grid metres.
         */
        update(readings, dt, rackReadings = []) {
            const usable = readings.filter((reading) => reading.rssi >= this.signal.model.usable_dbm);
            const rm = this.signal.rackModel;
            const racks = rm ? rackReadings.filter((r) => r.rssi >= rm.fix_dbm - RACK_USED_BELOW_FIX_DB).slice(0, RACK_READINGS_USED) : [];
            if (!usable.length && !racks.length) {
                // Nothing to position from: hold the last estimate, less and less sure of it.
                if (this.estimate) {
                    this.estimate = { ...this.estimate, accuracy: this.estimate.accuracy + MAX_SPEED_MPS * dt, heard: 0, confidence: "lost" };
                }
                return this.estimate;
            }
            if (!this.ready) {
                if (racks.length) { for (let i = 0; i < this.count; i += 1) [this.x[i], this.y[i]] = this.nearRack(racks[0]); this.ready = true; }
                else this.reset(usable[0]);
            }
            const { x, y, w, count, floor, signal, random } = this;
            // Motion: anyone may have walked up to MAX_SPEED_MPS since the last scan.
            const sigma = WALK_SIGMA_M + MAX_SPEED_MPS * dt * 0.6;
            for (let i = 0; i < count; i += 1) {
                const nx = x[i] + gaussian(random) * sigma, ny = y[i] + gaussian(random) * sigma;
                if (floor.isWalkable(nx, ny)) { x[i] = nx; y[i] = ny; }
            }
            // Sensor resetting: a few particles near the strongest rack (or ceiling) beacon keep the filter from getting lost.
            const resets = Math.max(1, Math.round(count * RESET_SHARE));
            for (let k = 0; k < resets; k += 1) {
                const i = Math.floor(random() * count);
                [x[i], y[i]] = racks.length ? this.nearRack(racks[0]) : this.nearBeacon(usable[0]);
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
                const cell = floor.cellAt(x[i], y[i]);
                for (const beacon of trusted) {
                    const expected = signal.expectedAt(beacon, cell, x[i], y[i]);
                    const rssi = heard.get(beacon.id);
                    let z = 0;
                    if (rssi == null) z = Math.max(0, expected - sensitivity) / LIKELIHOOD_SIGMA_DB;
                    else z = (rssi - expected) / (rssi >= usableDbm ? LIKELIHOOD_SIGMA_DB : WEAK_SIGMA_DB);
                    log -= 0.5 * z * z;
                }
                for (const { rack, rssi } of racks) {
                    const z = (rssi - signal.rackExpectedAt(rack, cell, x[i], y[i])) / RACK_LIKELIHOOD_SIGMA_DB;
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
            const scale = racks.length ? ACCURACY_SCALE.rack : ACCURACY_SCALE[signal.calibrated ? "calibrated" : "nominal"];
            const accuracy = Math.max(racks.length ? 0.3 : 1, scale * Math.sqrt(vx + vy));
            const sources = usable.length + racks.length;
            const confidence = accuracy <= CONFIDENCE.high && sources >= 3 ? "high" : accuracy <= CONFIDENCE.medium && sources >= 2 ? "medium" : "low";
            this.estimate = { x: ex, y: ey, accuracy, heard: usable.length, racks: racks.length, confidence, source: racks.length ? "rack" : "ceiling" };
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

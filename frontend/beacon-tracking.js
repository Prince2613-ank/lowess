/* ==========================================================================
 * Live BLE tracking (the "Tracking" tab): simulated beacons, carts and staff
 * positioned from signal strength, with proximity and zone events.
 *
 * Stage 1 (simulation): the store's illustrative beacons (BeaconSim, data from
 * scripts/build_beacons.py) are heard by every tracked cart and staff member
 * once a second; positions come from those readings alone (particle filter on
 * the walking grid), each with an accuracy circle and a confidence class.
 * The simulated true position is drawn too, so the gap between beacon
 * positioning and a perfect GPS-like track stays visible.
 *
 * Stage 2 (integration with the store's operations):
 *   - carts walk their real picking routes (picking-workflow.js): to the next
 *     stop on the plan, wait there for the picker's scan, then on to the next
 *     and back to Pack & Dispatch;
 *   - scan confirmation: a cart at its stop asks for the scan, with the beacon
 *     check of where the cart is; confirming picks the stop's items (stock is
 *     deducted from the inventory as usual). "Auto-confirm scans" lets the
 *     simulated pickers scan on their own;
 *   - every pick is checked against the cart's beacon position: location-
 *     verified or not (shown in the picking checklist);
 *   - staff near a low or out-of-stock rack raise a restock opportunity;
 *   - zone entry/exit (back-of-house areas, departments, main aisles) and
 *     time spent per zone.
 * Stage 3 (a real hardware pilot) replaces the simulated readings with a
 * receiver's scans; the positioning and events stay the same.
 *
 * Hooks used by the existing app:
 *   onBeaconStoreReady(store, alignedData, sourceData) - inventory.js
 *   clearBeaconTracking()                             - app.js
 *   onTrackingTabChanged(tab)                         - picking-workflow.js
 *   onBeaconPick(orderId, lineNo), beaconPickBadge(), beaconCartFixNode()
 *                                                     - picking-workflow.js
 * ========================================================================== */

const TRACKING_SOURCE = "tracking-tags";
const TRACKING_RANGE_SOURCE = "tracking-ranges";
const TRACKING_LAYERS = ["tracking-range-fill", "tracking-range-outline", "tracking-path", "tracking-trail", "tracking-accuracy-fill",
    "tracking-accuracy-casing", "tracking-accuracy-outline", "tracking-signals", "tracking-error", "tracking-truth"];
const TRACKING_SPEEDS = [1, 4, 10];
const TRACKING_STEP_S = 0.25;      // s of simulated time per movement step
const ZONE_DWELL_S = 3;            // a new zone must hold this long before entry/exit is reported
const PROXIMITY_M = 6;             // beacon fix this close to a rack: at the rack
const DEPART_M = 10;               // ...and this far: left it
const RESTOCK_NEAR_M = 4;
const RESTOCK_DWELL_S = 6;
const RESTOCK_REPEAT_S = 900;      // the same person and rack are reported again after this long
const SIGNAL_LOST_S = 5;
const TRAIL_SCANS = 30;
const MAX_EVENTS = 300;
const EVENT_LIST = 80;
const STRONG_SIGNAL_DBM = -80;     // range circles: where a beacon is heard this strongly (free space)
const STAFF_SPEED_MPS = 1.2;
const TAG_FOCUS_ZOOM = 19.5;       // close enough that a few-metre accuracy circle is wider than the badge
const SCAN_SECONDS_PER_LINE = 5;   // simulated pickers: time to pick and scan each item
const STAFF = [
    { id: "STAFF-1", name: "A. Lee", short: "AL", role: "Receiving", mode: "receiving" },
    { id: "STAFF-2", name: "J. Kim", short: "JK", role: "Restocking", mode: "restock" },
    { id: "STAFF-3", name: "R. Diaz", short: "RD", role: "Returns", mode: "returns" },
    { id: "STAFF-4", name: "T. Brown", short: "TB", role: "Sales floor", mode: "floor" },
];
const STAFF_COLOR = "#334155";
const EVENT_FILTERS = { all: () => true, zone: (e) => e.kind === "zone", rack: (e) => e.kind === "rack" || e.kind === "scan" || e.kind === "cart", signal: (e) => e.kind === "signal" };

const tracking = {
    storeId: null,
    data: null,
    floor: null,
    signal: null,
    network: null,
    loading: false,
    error: "",
    generation: 0,
    toMap: null,
    layersReady: false,
    running: true,
    speed: 1,              // real time; 4x and 10x fast-forward a demo
    simTime: 0,
    nextScan: 0,
    clockBase: Date.now(),
    frame: null,
    lastFrame: 0,
    renderAt: 0,
    panelAt: 0,
    random: Math.random,
    tags: [],
    selectedTagId: null,
    events: [],
    eventId: 0,
    eventFilter: "all",
    renderedEvents: null,
    show: { beacons: true, range: false, truth: true },
    autoScan: false,
    beaconMarkers: [],
    rackPoints: [],
    zoneCells: {},
    zoneTime: new Map(),
    verifications: new Map(),   // order#line -> { verified, distance, accuracy, cart }
    check: { errors: [], zoneHits: 0, zoneScans: 0 },
    rows: null,
    scanSignature: "",
    confirming: null,
};

const tr$ = (id) => document.getElementById(id);
const trackingActive = () => typeof picking !== "undefined" && picking.tab === "tracking";
const trackingReady = () => Boolean(tracking.data && tracking.floor && tracking.tags.length);
const metres = (value) => (value >= 10 ? `${Math.round(value)} m` : `${value.toFixed(1)} m`);
const CONFIDENCE_TEXT = { high: "High", medium: "Medium", low: "Low", lost: "No signal" };

/* ---------------------------------------------------------------------- */
/* Geometry                                                                */
/* ---------------------------------------------------------------------- */

function trackingToMap(x, y) {
    const point = tracking.floor.toSource(x, y);
    return tracking.toMap ? tracking.toMap(point) : point;
}

// A round circle on the map around grid point (x, y). The store map's alignment can
// stretch one axis a little, so the radius is the mean of the two stretched radii
// (same area) rather than an oval drawn in grid metres.
function circleRing(x, y, radius, points = 40) {
    const [lng, lat] = trackingToMap(x, y);
    const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110574;
    const along = ([lng2, lat2]) => Math.hypot((lng2 - lng) * kx, (lat2 - lat) * ky);
    const r = Math.sqrt(along(trackingToMap(x + radius, y)) * along(trackingToMap(x, y + radius)));
    const ring = [];
    for (let i = 0; i <= points; i += 1) {
        const angle = (i / points) * 2 * Math.PI;
        ring.push([lng + (Math.cos(angle) * r) / kx, lat + (Math.sin(angle) * r) / ky]);
    }
    return ring;
}

function rackXY(rackId) {
    const cell = tracking.network?.rackAccess[rackId];
    return cell == null ? null : tracking.floor.cellXY(cell);
}

// Walking path (corner points, grid metres) between two cells of the network.
function walkPath(fromCell, toCell) {
    const network = tracking.network;
    if (fromCell === toCell) return [tracking.floor.cellXY(toCell)];
    if (!network.connected(fromCell, toCell)) return null;
    const cells = IndoorRouting.Network.pathFrom(network.route(fromCell, [toCell]), toCell);
    return cells ? network.corners(cells).map((cell) => tracking.floor.cellXY(cell)) : null;
}

function tagCell(tag) {
    const floor = tracking.floor;
    const cell = floor.cellAt(tag.x, tag.y);
    if (cell >= 0 && floor.walkable[cell]) return cell;
    const [x, y] = floor.snap(tag.x, tag.y);
    return floor.cellAt(x, y);
}

/* ---------------------------------------------------------------------- */
/* Tracked carts and staff                                                 */
/* ---------------------------------------------------------------------- */

function newTag(fields, cell) {
    const [x, y] = tracking.floor.cellXY(cell);
    return {
        ...fields, x, y,
        path: null, leg: 0, target: null, state: "parked", stateSince: 0, dwellUntil: 0,
        radio: {}, filter: new BeaconSim.ParticleFilter(tracking.floor, tracking.signal, tracking.random),
        est: null, readings: [], smoothed: new Map(), trail: [],
        zone: null, zoneCandidate: null, near: null, nearCount: 0,
        restockCandidate: null, restockSeen: new Map(), lostSince: null, lost: false,
        skipped: new Set(), scanAt: null, history: 0,
    };
}

function buildTags() {
    const network = tracking.network;
    const dispatch = dispatchCell();
    const home = dispatch ?? tracking.data.beacons[0].cell;
    const tags = [];
    for (const cart of picking.store?.carts || []) {
        const start = cart.location && network.rackAccess[cart.location] != null ? network.rackAccess[cart.location] : home;
        tags.push(newTag({ id: cart.cart_id, kind: "cart", cartId: cart.cart_id, name: cart.name, short: cart.name.replace(/^Cart\s*0?/, "C"), role: cart.picker, color: cart.color }, start));
    }
    for (const staff of STAFF) {
        const start = staff.mode === "receiving" ? tracking.zoneCells.receiving ?? home
            : staff.mode === "returns" ? tracking.zoneCells.returns ?? home
            : randomRackCell() ?? home;
        const tag = newTag({ ...staff, kind: "staff", color: STAFF_COLOR }, start);
        Object.assign(tag, { state: "dwell", dwellUntil: 5 + tracking.random() * 20, step: 0 });
        tags.push(tag);
    }
    return tags;
}

function randomRackCell(preferLow = false) {
    const racks = tracking.rackPoints;
    if (!racks.length) return null;
    if (preferLow && inventory.model) {
        const low = racks.filter((rack) => inventory.model.get(rack.rackId)?.inventory_status !== "In Stock");
        if (low.length && tracking.random() < 0.6) return low[Math.floor(tracking.random() * low.length)].cell;
    }
    return racks[Math.floor(tracking.random() * racks.length)].cell;
}

function setTarget(tag, target) {
    if (!target || target.cell == null) return;
    if (tag.target && tag.target.kind === target.kind && tag.target.cell === target.cell && tag.target.rackId === target.rackId) return;
    tag.target = target;
    const path = walkPath(tagCell(tag), target.cell);
    if (!path) { tag.path = null; tag.state = "stuck"; return; }
    tag.path = path;
    tag.leg = 0;
    tag.state = "walking";
    tag.stateSince = tracking.simTime;
    if (path.length === 1) arrive(tag);
}

function cartTarget(tag) {
    const cart = picking.store?.cart(tag.cartId);
    const dispatch = dispatchCell();
    if (!cart || !cart.orders.length) return { kind: "dispatch", cell: dispatch, label: "Pack & Dispatch" };
    if (!cart.started) {
        if (!tracking.autoScan) return { kind: "dispatch", cell: dispatch, label: "Pack & Dispatch", waiting: true };
        picking.store.startPicking(cart.cart_id);
        addEvent("cart", tag, `${tag.name} started picking`, `${cart.orders.length} order${cart.orders.length === 1 ? "" : "s"} · simulated picker`);
        if (typeof refreshPicking === "function") refreshPicking();
    }
    const plan = planFor(cart.cart_id);
    const next = plan?.order.find((rackId) => !tag.skipped.has(rackId) && tracking.network.rackAccess[rackId] != null);
    return next ? { kind: "rack", rackId: next, cell: tracking.network.rackAccess[next], label: next }
        : { kind: "dispatch", cell: dispatch, label: "Pack & Dispatch", returning: true };
}

function staffTarget(tag) {
    const zones = tracking.zoneCells;
    tag.step += 1;
    const rack = () => ({ kind: "rack-visit", cell: randomRackCell(tag.mode === "restock"), label: "a rack" });
    const zone = (type, label) => (zones[type] != null ? { kind: "zone", cell: zones[type], label } : rack());
    if (tag.mode === "receiving") return tag.step % 2 ? rack() : zone("receiving", "Receiving Area");
    if (tag.mode === "returns") return [zone("dispatch", "Pack & Dispatch"), rack(), zone("returns", "Returns Area")][tag.step % 3];
    return rack();
}

function arrive(tag) {
    const target = tag.target;
    tag.path = null;
    tag.stateSince = tracking.simTime;
    if (tag.kind === "staff") {
        tag.state = "dwell";
        tag.dwellUntil = tracking.simTime + (target.kind === "zone" ? 20 + tracking.random() * 40 : 10 + tracking.random() * 30);
        return;
    }
    if (target.kind === "rack") {
        tag.state = "at-stop";
        const lines = stopLines(tag).length;
        tag.scanAt = tracking.simTime + 4 + SCAN_SECONDS_PER_LINE * Math.max(1, lines);
        return;
    }
    tag.state = "parked";
    if (target.returning) {
        const ready = (picking.store?.cart(tag.cartId)?.orders || []).filter((id) => picking.store.status(picking.store.order(id)) === "Picked").length;
        addEvent("cart", tag, `${tag.name} back at Pack & Dispatch`, ready ? `${ready} order${ready === 1 ? "" : "s"} ready to pack` : "Route complete");
    }
}

function stopLines(tag) {
    const cart = picking.store?.cart(tag.cartId);
    const plan = cart && planFor(cart.cart_id);
    const stop = plan?.stops.find((s) => s.rack_id === tag.target?.rackId);
    return stop ? stop.lines.filter((entry) => !entry.picked) : [];
}

function steer(tag) {
    if (tag.kind === "cart") {
        setTarget(tag, cartTarget(tag));
        if (tag.state === "at-stop" && tracking.autoScan && tracking.simTime >= tag.scanAt) confirmScan(tag.id, { auto: true });
        return;
    }
    if (tag.state === "walking") return;
    if (tag.state === "dwell" && tracking.simTime < tag.dwellUntil) return;
    tag.target = null;
    setTarget(tag, staffTarget(tag));
}

function move(tag, dt) {
    if (tag.state !== "walking" || !tag.path) return;
    const speed = tag.kind === "cart" ? Number(picking.store?.settings.walkSpeed) || 1 : STAFF_SPEED_MPS;
    let left = speed * dt;
    while (left > 0 && tag.leg < tag.path.length - 1) {
        const [x1, y1] = tag.path[tag.leg + 1];
        const d = Math.hypot(x1 - tag.x, y1 - tag.y);
        if (d <= left) { tag.x = x1; tag.y = y1; tag.leg += 1; left -= d; }
        else { tag.x += ((x1 - tag.x) / d) * left; tag.y += ((y1 - tag.y) / d) * left; left = 0; }
    }
    if (tag.leg >= tag.path.length - 1) arrive(tag);
}

/* ---------------------------------------------------------------------- */
/* Scans: positions, zones, proximity                                      */
/* ---------------------------------------------------------------------- */

function scanTag(tag, interval) {
    const floor = tracking.floor;
    const readings = tracking.signal.scan(tag.radio, tag.x, tag.y);
    tag.readings = readings;
    for (const { beacon, rssi } of readings) {
        const previous = tag.smoothed.get(beacon.id);
        tag.smoothed.set(beacon.id, previous == null ? rssi : previous + 0.35 * (rssi - previous));
    }
    for (const id of tag.smoothed.keys()) if (!readings.some((r) => r.beacon.id === id)) tag.smoothed.delete(id);
    const est = tag.filter.update(readings, interval);
    tag.est = est;
    if (!est) return;
    if (est.confidence !== "lost") {
        tag.trail.push([est.x, est.y]);
        if (tag.trail.length > TRAIL_SCANS) tag.trail.shift();
    }
    signalEvents(tag, est);
    zoneEvents(tag, est, interval);
    if (tag.kind === "cart") rackEvents(tag, est);
    else restockEvents(tag, est);
    // Simulation check against the true position.
    const check = tracking.check;
    check.errors.push(Math.hypot(est.x - tag.x, est.y - tag.y));
    if (check.errors.length > 600) check.errors.shift();
    if (tag.zone) {
        check.zoneScans += 1;
        if (floor.zoneAt(tag.x, tag.y) === tag.zone) check.zoneHits += 1;
    }
}

function signalEvents(tag, est) {
    if (est.confidence === "lost") {
        tag.lostSince ??= tracking.simTime;
        if (!tag.lost && tracking.simTime - tag.lostSince >= SIGNAL_LOST_S) {
            tag.lost = true;
            addEvent("signal", tag, `${tag.name} lost beacon signal`, `Last fix in ${tag.zone || "the store"} - position held, accuracy growing`, "warn");
        }
        return;
    }
    if (tag.lost) addEvent("signal", tag, `${tag.name} beacon signal back`, `${est.heard} beacons heard · ±${metres(est.accuracy)}`);
    tag.lost = false;
    tag.lostSince = null;
}

function zoneEvents(tag, est, interval) {
    if (est.confidence === "lost") return;
    const zone = tracking.floor.zoneAt(est.x, est.y);
    if (tag.zone) tracking.zoneTime.set(tag.zone, (tracking.zoneTime.get(tag.zone) || 0) + interval);
    if (!tag.zone) { tag.zone = zone; return; }        // first fix: no entry event
    if (zone === tag.zone) { tag.zoneCandidate = null; return; }
    if (tag.zoneCandidate?.name !== zone) { tag.zoneCandidate = { name: zone, since: tracking.simTime }; return; }
    if (tracking.simTime - tag.zoneCandidate.since < ZONE_DWELL_S) return;
    addEvent("zone", tag, `${tag.name} entered ${zone}`, `Left ${tag.zone} · ±${metres(est.accuracy)} (${CONFIDENCE_TEXT[est.confidence].toLowerCase()} confidence)`);
    tag.zone = zone;
    tag.zoneCandidate = null;
}

function rackEvents(tag, est) {
    if (est.confidence === "lost") return;
    const distanceTo = (rackId) => {
        const xy = rackXY(rackId);
        return xy ? Math.hypot(est.x - xy[0], est.y - xy[1]) : Infinity;
    };
    if (tag.near && distanceTo(tag.near.rackId) > DEPART_M) {
        addEvent("rack", tag, `${tag.name} left ${tag.near.rackId}`, `Beacon fix ${metres(distanceTo(tag.near.rackId))} from the rack`);
        tag.near = null;
    }
    const target = tag.target?.kind === "rack" ? tag.target.rackId : null;
    if (!target || tag.near?.rackId === target) {
        if (tag.near) Object.assign(tag.near, { distance: distanceTo(tag.near.rackId), accuracy: est.accuracy, confidence: est.confidence });
        tag.nearCount = 0;
        return;
    }
    const d = distanceTo(target);
    tag.nearCount = d <= PROXIMITY_M ? tag.nearCount + 1 : 0;
    if (tag.nearCount < 2) return;                    // two scans in a row
    tag.near = { rackId: target, since: tracking.simTime, distance: d, accuracy: est.accuracy, confidence: est.confidence };
    tag.nearCount = 0;
    const rack = inventory.model?.get(target);
    addEvent("rack", tag, `${tag.name} at ${target} (next stop)`,
        `${rack ? rackPlace(rack) : "Rack"} · beacon fix ${metres(d)} from the rack, ±${metres(est.accuracy)} (${CONFIDENCE_TEXT[est.confidence].toLowerCase()})`);
}

function restockEvents(tag, est) {
    if (est.confidence === "lost" || !inventory.model) return;
    let best = null, bestD = RESTOCK_NEAR_M;
    for (const rack of tracking.rackPoints) {
        const d = Math.hypot(rack.x - est.x, rack.y - est.y);
        if (d < bestD) { bestD = d; best = rack; }
    }
    const record = best && inventory.model.get(best.rackId);
    if (!record || record.inventory_status === "In Stock") { tag.restockCandidate = null; return; }
    if (tag.restockCandidate?.rackId !== best.rackId) { tag.restockCandidate = { rackId: best.rackId, since: tracking.simTime }; return; }
    const seen = tag.restockSeen.get(best.rackId);
    if (tracking.simTime - tag.restockCandidate.since < RESTOCK_DWELL_S || (seen != null && tracking.simTime - seen < RESTOCK_REPEAT_S)) return;
    tag.restockSeen.set(best.rackId, tracking.simTime);
    addEvent("rack", tag, `${tag.name} near ${best.rackId} · ${record.inventory_status}`,
        `${rackPlace(record)} · ${formatNumber(record.stock_quantity)} on the shelf - restock opportunity`, "warn", best.rackId);
}

/* ---------------------------------------------------------------------- */
/* Simulation clock                                                        */
/* ---------------------------------------------------------------------- */

function advanceTracking(seconds) {
    if (!trackingReady()) return;
    const interval = tracking.data.model.scan_interval_s || 1;
    let left = seconds;
    while (left > 1e-9) {
        const dt = Math.min(TRACKING_STEP_S, left);
        for (const tag of tracking.tags) { steer(tag); move(tag, dt); }
        tracking.simTime += dt;
        left -= dt;
        while (tracking.simTime >= tracking.nextScan) {
            for (const tag of tracking.tags) scanTag(tag, interval);
            tracking.nextScan += interval;
        }
    }
}

function trackingLoop(now) {
    tracking.frame = requestAnimationFrame(trackingLoop);
    const dt = Math.min(0.25, (now - (tracking.lastFrame || now)) / 1000);
    tracking.lastFrame = now;
    if (tracking.running) advanceTracking(dt * tracking.speed);
    // In real time the clock is the actual time of day (it catches up after a pause or fast-forward).
    if (tracking.running && tracking.speed === 1) tracking.clockBase = Date.now() - tracking.simTime * 1000;
    if (now - tracking.renderAt > 100) { tracking.renderAt = now; if (trackingActive()) renderTrackingMap(); }
    if (now - tracking.panelAt > 500) { tracking.panelAt = now; renderTrackingLive(); }
}

function startTrackingLoop() {
    if (tracking.frame == null) { tracking.lastFrame = 0; tracking.frame = requestAnimationFrame(trackingLoop); }
}

function stopTrackingLoop() {
    if (tracking.frame != null) cancelAnimationFrame(tracking.frame);
    tracking.frame = null;
}

// The simulation runs while a tab that shows it is open (Tracking, and Picking
// for the carts' beacon positions); elsewhere it pauses and costs nothing.
function syncTrackingLoop() {
    const shown = typeof picking !== "undefined" && (picking.tab === "tracking" || picking.tab === "picking");
    if (trackingReady() && shown) startTrackingLoop(); else stopTrackingLoop();
}

// Test and demo aid: run the simulation forward synchronously.
function trackingAdvance(seconds) {
    advanceTracking(seconds);
    if (trackingActive()) renderTrackingMap();
    renderTrackingLive(true);
}

const clockTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const simClock = (t = tracking.simTime) => clockTime(tracking.clockBase + t * 1000);

/* ---------------------------------------------------------------------- */
/* Events                                                                  */
/* ---------------------------------------------------------------------- */

function addEvent(kind, tag, text, detail = "", level = "info", rackId = null) {
    const at = tag?.est ? [tag.est.x, tag.est.y] : tag ? [tag.x, tag.y] : null;
    // Each event keeps the clock time it happened at.
    tracking.events.unshift({ id: ++tracking.eventId, t: tracking.simTime, clock: tracking.clockBase + tracking.simTime * 1000, kind, tagId: tag?.id || null, color: tag?.color, text, detail, level, at, rackId });
    if (tracking.events.length > MAX_EVENTS) tracking.events.length = MAX_EVENTS;
}

/* ---------------------------------------------------------------------- */
/* Scan confirmation and pick verification (Stage 2)                       */
/* ---------------------------------------------------------------------- */

// The picker scans the stop's items: each is picked through the picking workflow.
function confirmScan(tagId, { auto = false } = {}) {
    const tag = tracking.tags.find((t) => t.id === tagId);
    if (!tag || tag.state !== "at-stop" || tag.target?.kind !== "rack") return false;
    const rackId = tag.target.rackId;
    const lines = stopLines(tag);
    tracking.confirming = { tagId, rackId, auto };
    let short = 0;
    for (const entry of lines) {
        const stock = picking.store.available(inventory.model, entry.line);
        if (stock == null || stock < entry.line.quantity) { short += 1; continue; }
        pickLine(entry.order_id, entry.line.line_no);
    }
    tracking.confirming = null;
    if (short) {
        tag.skipped.add(rackId);
        addEvent("scan", tag, `${tag.name} skipped ${rackId}`, `${short} item${short === 1 ? "" : "s"} short on the shelf - flagged for review`, "warn", rackId);
    }
    tag.scanAt = null;
    // On to the next stop (or back to Pack & Dispatch), planned from here.
    Object.assign(tag, { target: null, state: "parked" });
    setTarget(tag, cartTarget(tag));
    renderTrackingLive(true);
    return true;
}

// Called by the picking workflow after every successful pick.
function onBeaconPick(orderId, lineNo) {
    if (!trackingReady() || !picking.store) return;
    const order = picking.store.order(orderId);
    const line = order?.lines.find((item) => item.line_no === lineNo);
    const cart = picking.store.cartOf(orderId);
    const tag = cart && tracking.tags.find((t) => t.cartId === cart.cart_id);
    if (!line || !tag) return;
    const xy = rackXY(line.rack_id);
    const est = tag.est && tag.est.confidence !== "lost" ? tag.est : null;
    const distance = est && xy ? Math.hypot(est.x - xy[0], est.y - xy[1]) : null;
    const verified = distance != null && distance <= Math.max(PROXIMITY_M, est.accuracy);
    tracking.verifications.set(`${orderId}#${lineNo}`, { verified, distance, accuracy: est?.accuracy ?? null, cart: tag.name });
    const scanned = tracking.confirming?.tagId === tag.id ? (tracking.confirming.auto ? "Scanned by the simulated picker" : "Scan confirmed") : "Marked picked";
    if (verified) {
        addEvent("scan", tag, `Pick at ${line.rack_id} location-verified`, `${scanned} · ${line.product_name} (${orderId}) · beacon fix ${metres(distance)} from the rack (±${metres(est.accuracy)})`, "ok", line.rack_id);
    } else {
        addEvent("scan", tag, `Pick at ${line.rack_id} not location-verified`,
            distance == null ? `${scanned} · ${orderId} · no beacon fix for ${tag.name}` : `${scanned} · ${orderId} · ${tag.name} is ${metres(distance)} from the rack by beacon (±${metres(est.accuracy)}) - check the barcode scan`, "warn", line.rack_id);
    }
}

// Badge for a picked line in the picking checklist.
function beaconPickBadge(orderId, lineNo) {
    const check = tracking.verifications.get(`${orderId}#${lineNo}`);
    if (!check) return null;
    return check.verified
        ? h("span", { className: "tracking-verified ok", title: `Beacon fix ${metres(check.distance)} from the rack (±${metres(check.accuracy)})` }, "Location verified")
        : h("span", { className: "tracking-verified warn", title: check.distance == null ? "No beacon fix at the time of the pick" : `Cart ${metres(check.distance)} from the rack by beacon` }, "Location not verified");
}

function cartFixText(cartId) {
    const tag = tracking.tags.find((t) => t.cartId === cartId);
    if (!tag?.est) return "";
    const est = tag.est;
    if (est.confidence === "lost") return `No beacon signal · last fix in ${tag.zone || "the store"}`;
    return `${tag.zone || tracking.floor.zoneAt(est.x, est.y)} · ±${metres(est.accuracy)} (${CONFIDENCE_TEXT[est.confidence].toLowerCase()} confidence) · ${est.heard} beacons`;
}

// Live line in the picking tab's cart detail.
function beaconCartFixNode(cartId) {
    if (!trackingReady()) return null;
    return h("p", { className: "picking-beacon-fix", id: "picking-beacon-fix", dataset: { cartId } },
        h("strong", {}, "Beacon position: "), h("span", {}, cartFixText(cartId) || "waiting for the first scan…"));
}

/* ---------------------------------------------------------------------- */
/* Map                                                                     */
/* ---------------------------------------------------------------------- */

function ensureTrackingLayers() {
    const map = state.map;
    // Added once the store map's own layers exist (the style has loaded by then).
    if (tracking.layersReady || !map || !map.getSource(INVENTORY_SOURCE)) return;
    map.addSource(TRACKING_RANGE_SOURCE, { type: "geojson", data: emptyCollection() });
    map.addSource(TRACKING_SOURCE, { type: "geojson", data: emptyCollection() });
    const kind = (name) => ["==", ["get", "kind"], name];
    const hidden = { visibility: "none" };
    map.addLayer({ id: "tracking-range-fill", type: "fill", source: TRACKING_RANGE_SOURCE, layout: hidden, paint: { "fill-color": "#0e7490", "fill-opacity": 0.05 } });
    map.addLayer({ id: "tracking-range-outline", type: "line", source: TRACKING_RANGE_SOURCE, layout: hidden,
        paint: { "line-color": "#0e7490", "line-width": 1, "line-opacity": 0.45, "line-dasharray": [3, 3] } });
    map.addLayer({ id: "tracking-path", type: "line", source: TRACKING_SOURCE, filter: kind("path"), layout: { ...hidden, "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": 0.55, "line-dasharray": [1.5, 1.5] } });
    map.addLayer({ id: "tracking-trail", type: "line", source: TRACKING_SOURCE, filter: kind("trail"), layout: { ...hidden, "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.35 } });
    // Accuracy circle: a tinted disc with a white-cased outline so it reads over the rack colours;
    // dashed when the confidence is low (or the signal is lost), as the map key says.
    const weak = ["match", ["get", "confidence"], ["low", "lost"], true, false];
    map.addLayer({ id: "tracking-accuracy-fill", type: "fill", source: TRACKING_SOURCE, filter: kind("accuracy"), layout: hidden,
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "selected"], 0.3, 0.2] } });
    map.addLayer({ id: "tracking-accuracy-casing", type: "line", source: TRACKING_SOURCE, filter: kind("accuracy"), layout: hidden,
        paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 6, 4.5], "line-opacity": 0.9 } });
    map.addLayer({ id: "tracking-accuracy-outline", type: "line", source: TRACKING_SOURCE, filter: kind("accuracy"), layout: hidden,
        paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "selected"], 3, 2.2],
            "line-dasharray": ["case", weak, ["literal", [2, 1.5]], ["literal", [1, 0]]] } });
    map.addLayer({ id: "tracking-signals", type: "line", source: TRACKING_SOURCE, filter: kind("signal"), layout: { ...hidden, "line-cap": "round" },
        paint: { "line-color": ["interpolate", ["linear"], ["get", "strength"], 0, "#94a3b8", 0.5, "#38bdf8", 1, "#0369a1"],
            "line-width": ["interpolate", ["linear"], ["get", "strength"], 0, 1, 1, 4], "line-opacity": 0.85 } });
    map.addLayer({ id: "tracking-error", type: "line", source: TRACKING_SOURCE, filter: kind("error"), layout: hidden,
        paint: { "line-color": "#0f172a", "line-width": 1.2, "line-opacity": 0.55, "line-dasharray": [1, 1.5] } });
    map.addLayer({ id: "tracking-truth", type: "circle", source: TRACKING_SOURCE, filter: kind("truth"), layout: hidden,
        paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-opacity": 0.5, "circle-stroke-color": "#0f172a", "circle-stroke-width": 2, "circle-stroke-opacity": 0.75 } });
    // Shown from store level in, like the cart and staff badges (hidden further out).
    for (const id of TRACKING_LAYERS) map.setLayerZoomRange(id, ZOOM.STORE_LEVEL, 24);
    tracking.layersReady = true;
}

// Other modules add their layers later (activity, forecast, 3D); keep tracking on top.
function raiseTrackingLayers() {
    if (!tracking.layersReady) return;
    for (const id of TRACKING_LAYERS) state.map.moveLayer(id);
}

function beaconPopup(beacon) {
    const m = tracking.data.model;
    return h("div", { className: "zone-popup" },
        h("div", { className: "zone-popup-title" }, `Beacon ${beacon.name}`),
        h("div", {}, beacon.label),
        h("div", {}, `Measured power ${beacon.tx_power_dbm} dBm at 1 m · advertising every ${m.advertising_interval_ms} ms`),
        h("div", {}, `Battery ${beacon.battery_pct}%${beacon.battery_pct < 65 ? " - schedule a replacement" : ""}`),
        h("div", { className: "zone-popup-note" }, `Ceiling-mounted at ${m.mount_height_m} m. Illustrative position, simulated signal.`));
}

function buildBeaconMarkers() {
    for (const marker of tracking.beaconMarkers) marker.remove();
    tracking.beaconMarkers = [];
    if (!tracking.data || !state.map) return;
    for (const beacon of tracking.signal.beacons) {
        const element = h("button", { type: "button", className: `tracking-beacon${beacon.zone_type ? " zone" : ""}`, title: `Beacon ${beacon.name} · ${beacon.label}`, "aria-label": `Beacon ${beacon.name}` },
            h("span", { className: "tracking-beacon-dot" }), h("span", { className: "tracking-beacon-name" }, beacon.name));
        element.addEventListener("click", (event) => {
            event.stopPropagation();
            new maplibregl.Popup({ maxWidth: "260px", offset: 12 }).setLngLat(trackingToMap(beacon.x, beacon.y)).setDOMContent(beaconPopup(beacon)).addTo(state.map);
        });
        tracking.beaconMarkers.push(new maplibregl.Marker({ element, anchor: "center" }).setLngLat(trackingToMap(beacon.x, beacon.y)));
    }
}

function buildTagMarkers() {
    for (const tag of tracking.tags) {
        tag.marker?.remove();
        const element = h("button", { type: "button", className: `tracking-tag ${tag.kind}`, style: { "--tag": tag.color }, "aria-label": `${tag.name} (${tag.role})`, dataset: { tagId: tag.id } },
            h("span", { className: "tracking-tag-icon" }, tag.short), h("span", { className: "tracking-tag-name" }, tag.name));
        element.addEventListener("click", (event) => { event.stopPropagation(); selectTag(tag.id); });
        tag.marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(trackingToMap(tag.x, tag.y));
    }
}

function rangeData() {
    if (!tracking.signal) return emptyCollection();
    const signal = tracking.signal;
    return { type: "FeatureCollection", features: signal.beacons.map((beacon) => {
        const d3 = 10 ** ((beacon.tx_power_dbm - STRONG_SIGNAL_DBM) / (10 * signal.model.path_loss_exponent));
        const radius = Math.sqrt(Math.max(1, d3 * d3 - signal.drop * signal.drop));
        return { type: "Feature", properties: { id: beacon.id }, geometry: { type: "Polygon", coordinates: [circleRing(beacon.x, beacon.y, radius, 48)] } };
    }) };
}

function tagFeatures() {
    const features = [];
    const selected = tracking.selectedTagId;
    for (const tag of tracking.tags) {
        const est = tag.est;
        const isSelected = tag.id === selected;
        const props = { color: tag.color, selected: isSelected, tag: tag.id };
        if (est) {
            features.push({ type: "Feature", properties: { ...props, kind: "accuracy", confidence: est.confidence }, geometry: { type: "Polygon", coordinates: [circleRing(est.x, est.y, est.accuracy)] } });
            if (tracking.show.truth) {
                features.push({ type: "Feature", properties: { ...props, kind: "error" }, geometry: { type: "LineString", coordinates: [trackingToMap(est.x, est.y), trackingToMap(tag.x, tag.y)] } });
            }
        }
        if (tag.trail.length > 1) features.push({ type: "Feature", properties: { ...props, kind: "trail" }, geometry: { type: "LineString", coordinates: tag.trail.map(([x, y]) => trackingToMap(x, y)) } });
        if (tracking.show.truth) features.push({ type: "Feature", properties: { ...props, kind: "truth" }, geometry: { type: "Point", coordinates: trackingToMap(tag.x, tag.y) } });
        if (isSelected && tag.path && tag.state === "walking") {
            const rest = [[tag.x, tag.y], ...tag.path.slice(tag.leg + 1)];
            if (rest.length > 1) features.push({ type: "Feature", properties: { ...props, kind: "path" }, geometry: { type: "LineString", coordinates: rest.map(([x, y]) => trackingToMap(x, y)) } });
        }
        if (isSelected && est && est.confidence !== "lost") {
            const m = tracking.data.model;
            for (const { beacon, rssi } of tag.readings) {
                if (rssi < m.usable_dbm) continue;
                const strength = Math.max(0, Math.min(1, (rssi - m.usable_dbm) / (beacon.tx_power_dbm - 15 - m.usable_dbm)));
                features.push({ type: "Feature", properties: { ...props, kind: "signal", strength }, geometry: { type: "LineString", coordinates: [trackingToMap(est.x, est.y), trackingToMap(beacon.x, beacon.y)] } });
            }
        }
    }
    // Selected tag drawn last, on top.
    features.sort((a, b) => a.properties.selected - b.properties.selected);
    return { type: "FeatureCollection", features };
}

function renderTrackingMap() {
    const map = state.map;
    if (!map) return;
    ensureTrackingLayers();
    if (!tracking.layersReady) return;
    const show = trackingActive() && trackingReady();
    for (const id of TRACKING_LAYERS) {
        const range = id.startsWith("tracking-range");
        map.setLayoutProperty(id, "visibility", show && (!range || tracking.show.range) && (id !== "tracking-truth" && id !== "tracking-error" || tracking.show.truth) ? "visible" : "none");
    }
    const place = (marker, visible) => {
        if (visible && !marker.shown) marker.addTo(map);
        else if (!visible && marker.shown) marker.remove();
        marker.shown = visible;
    };
    for (const marker of tracking.beaconMarkers) place(marker, show && tracking.show.beacons);
    for (const tag of tracking.tags) {
        if (!tag.marker) continue;
        place(tag.marker, Boolean(show && tag.est));
        if (!tag.marker.shown) continue;
        tag.marker.setLngLat(trackingToMap(tag.est.x, tag.est.y));
        const element = tag.marker.getElement();
        element.classList.toggle("selected", tag.id === tracking.selectedTagId);
        element.classList.toggle("low", tag.est.confidence === "low" || tag.est.confidence === "lost");
        element.title = `${tag.name} · ${tag.role} · ±${metres(tag.est.accuracy)} (${CONFIDENCE_TEXT[tag.est.confidence]})`;
    }
    if (!show) {
        map.getSource(TRACKING_SOURCE)?.setData(emptyCollection());
        return;
    }
    map.getSource(TRACKING_SOURCE).setData(tagFeatures());
}

/* ---------------------------------------------------------------------- */
/* Panel                                                                   */
/* ---------------------------------------------------------------------- */

function trackingTile(label, value, caption, id) {
    return h("div", { className: "activity-stat" }, h("strong", { id }, value), h("span", {}, label), h("small", { id: `${id}-caption` }, caption));
}

const median = (values) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
};

function signalBars(rssi) {
    const m = tracking.data.model;
    const level = rssi == null ? 0 : Math.max(1, Math.min(4, Math.ceil(((rssi - m.usable_dbm) / 25) * 4)));
    return h("span", { className: "tracking-bars", title: rssi == null ? "No signal" : `${Math.round(rssi)} dBm` },
        ...[1, 2, 3, 4].map((i) => h("i", { className: i <= level ? "on" : "" })));
}

function tagStatus(tag) {
    const cart = tag.kind === "cart" ? picking.store?.cart(tag.cartId) : null;
    switch (tag.state) {
        case "walking": return tag.target?.kind === "rack" ? `Walking to ${tag.target.rackId}` : `Walking to ${tag.target?.label || "…"}`;
        case "at-stop": return tracking.autoScan ? `Picking at ${tag.target?.rackId}` : `At ${tag.target?.rackId} · waiting for scan`;
        case "dwell": return tag.target ? `Working at ${tag.target.kind === "zone" ? tag.target.label : "a rack"}` : "Working";
        case "stuck": return "No walkable route";
        default:
            if (!cart?.orders.length) return "Idle at Pack & Dispatch";
            if (!cart.started) return "Waiting to start picking";
            return "At Pack & Dispatch";
    }
}

function buildTagRows() {
    const list = tr$("tracking-tags");
    tracking.rows = new Map();
    list.replaceChildren(...tracking.tags.map((tag) => {
        const refs = {
            status: h("span", { className: "tracking-tag-status" }),
            zone: h("span", { className: "tracking-tag-zone" }),
            acc: h("span", { className: "tracking-acc" }),
            bars: h("span", {}),
        };
        refs.root = h("button", { type: "button", className: "tracking-tag-row", style: { "--tag": tag.color }, dataset: { tagId: tag.id }, onClick: () => selectTag(tag.id) },
            h("span", { className: `tracking-tag-badge ${tag.kind}` }, tag.short),
            h("span", { className: "tracking-tag-main" }, h("strong", {}, tag.name), h("span", { className: "tracking-tag-role" }, ` · ${tag.role}`), refs.status, refs.zone),
            h("span", { className: "tracking-tag-side" }, refs.acc, refs.bars));
        tracking.rows.set(tag.id, refs);
        return refs.root;
    }));
}

function updateTagRows() {
    if (!tracking.rows || tracking.rows.size !== tracking.tags.length) buildTagRows();
    for (const tag of tracking.tags) {
        const refs = tracking.rows.get(tag.id);
        if (!refs) continue;
        const est = tag.est;
        refs.root.classList.toggle("selected", tag.id === tracking.selectedTagId);
        refs.root.setAttribute("aria-pressed", String(tag.id === tracking.selectedTagId));
        refs.status.textContent = tagStatus(tag);
        refs.zone.textContent = tag.zone ? `In ${tag.zone}` : "";
        refs.acc.className = `tracking-acc conf-${est?.confidence || "lost"}`;
        refs.acc.textContent = est ? (est.confidence === "lost" ? "No signal" : `±${metres(est.accuracy)}`) : "—";
        refs.acc.title = est ? `${CONFIDENCE_TEXT[est.confidence]} confidence · ${est.heard} beacons used` : "";
        refs.bars.replaceChildren(signalBars(tag.readings[0]?.rssi ?? null));
    }
}

function renderTagDetail() {
    const panel = tr$("tracking-tag-detail");
    const tag = tracking.tags.find((t) => t.id === tracking.selectedTagId);
    panel.hidden = !tag;
    if (!tag) return;
    if (panel.dataset.tagId !== tag.id) {
        panel.dataset.tagId = tag.id;
        setChildren(panel,
            h("div", { className: "inventory-details-header" },
                h("div", {}, h("div", { className: "inventory-details-kicker" }, tag.kind === "cart" ? "Picking cart" : "Staff badge"), h("h3", {}, tag.name)),
                h("button", { type: "button", className: "inventory-icon-button", "aria-label": "Close tracking details", onClick: () => selectTag(null) }, "×")),
            h("dl", { className: "inventory-fields", id: "tracking-detail-fields" }),
            h("table", { className: "inventory-products tracking-heard" },
                h("thead", {}, h("tr", {}, h("th", {}, "Beacon"), h("th", { className: "num" }, "RSSI"), h("th", { className: "num" }, "Distance"), h("th", { className: "num", title: "Simulation only" }, "True"))),
                h("tbody", { id: "tracking-heard-body" })),
            h("p", { className: "forecast-model" }, "RSSI smoothed over recent scans; distance from the signal model. \"True\" is the simulated distance, which a real system never sees."));
    }
    const est = tag.est;
    const field = (label, value) => h("div", { className: "inventory-field" }, h("dt", {}, label), h("dd", {}, value));
    const trueZone = tracking.floor.zoneAt(tag.x, tag.y);
    setChildren(tr$("tracking-detail-fields"),
        field("Status", tagStatus(tag)),
        field("Beacon zone", tag.zone || "—"),
        field("Accuracy", est ? (est.confidence === "lost" ? "No signal" : `±${metres(est.accuracy)} · ${CONFIDENCE_TEXT[est.confidence]}`) : "—"),
        field("Beacons used", est ? String(est.heard) : "—"),
        field("True zone (sim)", trueZone === tag.zone ? `${trueZone} ✓` : trueZone),
        field("Actual error (sim)", est ? metres(Math.hypot(est.x - tag.x, est.y - tag.y)) : "—"));
    const usable = tracking.data.model.usable_dbm;
    const rows = [...tag.smoothed].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, rssi]) => {
        const beacon = tracking.signal.beacons.find((b) => b.id === id);
        return h("tr", { className: rssi < usable ? "weak" : "" },
            h("td", { title: beacon.label }, h("strong", {}, beacon.name), h("div", { className: "sku" }, beacon.label)),
            h("td", { className: "num" }, `${Math.round(rssi)} dBm`),
            h("td", { className: "num" }, rssi < usable ? "too weak" : metres(tracking.signal.distanceFor(rssi, beacon))),
            h("td", { className: "num" }, metres(Math.hypot(beacon.x - tag.x, beacon.y - tag.y))));
    });
    tr$("tracking-heard-body").replaceChildren(...(rows.length ? rows : [h("tr", {}, h("td", { colspan: "4", className: "empty" }, "No beacons heard"))]));
}

function renderScans() {
    const box = tr$("tracking-scans");
    const pending = tracking.autoScan ? [] : tracking.tags.filter((tag) => tag.kind === "cart" && tag.state === "at-stop" && tag.target?.kind === "rack");
    const signature = pending.map((tag) => `${tag.id}:${tag.target.rackId}:${tag.near?.rackId === tag.target.rackId}`).join("|") + `|${tracking.autoScan}`;
    if (signature !== tracking.scanSignature) {
        tracking.scanSignature = signature;
        tr$("tracking-scans-head").hidden = !pending.length;
        setChildren(box, pending.map((tag) => {
            const lines = stopLines(tag);
            const rack = inventory.model?.get(tag.target.rackId);
            const near = tag.near?.rackId === tag.target.rackId;
            return h("div", { className: `tracking-scan ${near ? "ok" : "warn"}`, style: { "--tag": tag.color }, dataset: { tagId: tag.id } },
                h("div", { className: "tracking-scan-head" },
                    h("span", { className: "tracking-tag-badge cart" }, tag.short),
                    h("strong", {}, `${tag.name} at ${tag.target.rackId}`),
                    h("span", { className: "picking-muted" }, ` · ${rack ? rackPlace(rack) : ""}`)),
                h("div", { className: "tracking-scan-items" }, lines.length ? lines.map((entry) => `${entry.line.quantity} × ${entry.line.product_name}`).join(" · ") : "Nothing left to pick here"),
                h("div", { className: "tracking-scan-check", dataset: { check: tag.id } }),
                h("button", { type: "button", className: "primary", onClick: () => confirmScan(tag.id) }, lines.length ? `Confirm scan (${lines.length} item${lines.length === 1 ? "" : "s"})` : "Continue"));
        }));
    }
    for (const tag of pending) {
        const node = box.querySelector(`[data-check="${tag.id}"]`);
        if (!node) continue;
        const near = tag.near?.rackId === tag.target.rackId;
        const xy = rackXY(tag.target.rackId);
        const d = tag.est && xy ? Math.hypot(tag.est.x - xy[0], tag.est.y - xy[1]) : null;
        node.textContent = near
            ? `Beacon confirms the cart is here: ${metres(d)} from the rack, ±${metres(tag.est.accuracy)} (${CONFIDENCE_TEXT[tag.est.confidence].toLowerCase()} confidence).`
            : d == null ? "No beacon fix yet - confirm with the barcode scan."
            : `Beacon fix is ${metres(d)} from the rack (±${metres(tag.est.accuracy)}) - not yet confirmed; check the barcode scan.`;
    }
}

function renderEvents(force = false) {
    const list = tr$("tracking-events");
    const filter = EVENT_FILTERS[tracking.eventFilter] || EVENT_FILTERS.all;
    const key = `${tracking.eventId}|${tracking.eventFilter}`;
    // New events wait while the pointer is over the list, so a click never lands on a moving row.
    if (!force && (key === tracking.renderedEvents || list.matches(":hover"))) return;
    tracking.renderedEvents = key;
    for (const button of document.querySelectorAll("#tracking-event-filter button")) button.setAttribute("aria-pressed", String(button.dataset.filter === tracking.eventFilter));
    const events = tracking.events.filter(filter).slice(0, EVENT_LIST);
    tr$("tracking-event-count").textContent = `${tracking.events.filter(filter).length} events`;
    if (!events.length) { list.replaceChildren(h("li", { className: "empty" }, "No events yet. They appear as carts and staff move between zones and racks.")); return; }
    list.replaceChildren(...events.map((event) => h("li", { className: `tracking-event ${event.kind} ${event.level}`, style: { "--tag": event.color || "#64748b" } },
        h("button", { type: "button", onClick: () => focusEvent(event) },
            h("span", { className: "tracking-event-time" }, clockTime(event.clock)),
            h("span", { className: "tracking-event-body" }, h("strong", {}, event.text), event.detail ? h("span", {}, event.detail) : null)))));
}

function renderZoneTime() {
    const entries = [...tracking.zoneTime].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = entries[0]?.[1] || 1;
    const total = [...tracking.zoneTime.values()].reduce((s, v) => s + v, 0) || 1;
    tr$("tracking-zones").replaceChildren(...(entries.length ? entries.map(([zone, seconds]) => h("div", { className: "activity-bar-row tracking-zone-row", title: `${zone}: ${Math.round(seconds / 60)} min tracked` },
        h("span", { className: "activity-bar-label" }, zone),
        h("span", { className: "activity-bar-track" }, h("span", { className: "activity-bar tracking-zone-bar", style: { width: `${(seconds / max) * 100}%` } })),
        h("span", { className: "activity-bar-value" }, `${Math.round((seconds / total) * 100)}%`))) : [h("p", { className: "picking-muted" }, "Builds up as the simulation runs.")]));
}

function renderBeaconTable() {
    const body = tr$("tracking-beacon-body");
    if (body.dataset.storeId !== tracking.storeId) {
        body.dataset.storeId = tracking.storeId;
        const zoomTo = (beacon) => state.map.easeTo({ center: trackingToMap(beacon.x, beacon.y), zoom: Math.max(state.map.getZoom(), 19), duration: 500 });
        body.replaceChildren(...tracking.signal.beacons.map((beacon) => h("tr", {
            tabindex: "0", onClick: () => zoomTo(beacon),
            onKeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); zoomTo(beacon); } },
        },
            h("td", { className: "rack" }, beacon.name),
            h("td", { title: beacon.label }, beacon.label),
            h("td", { className: "num" }, h("span", { className: beacon.battery_pct < 65 ? "tracking-battery low" : "tracking-battery", title: beacon.battery_pct < 65 ? "Low battery - schedule a replacement" : null }, `${beacon.battery_pct}%`)),
            h("td", { className: "num", dataset: { heard: beacon.id } }, "0"))));
    }
    const heardBy = new Map();
    for (const tag of tracking.tags) for (const { beacon, rssi } of tag.readings) if (rssi >= tracking.data.model.usable_dbm) heardBy.set(beacon.id, (heardBy.get(beacon.id) || 0) + 1);
    for (const cell of body.querySelectorAll("[data-heard]")) cell.textContent = String(heardBy.get(cell.dataset.heard) || 0);
}

function renderTrackingStats() {
    const coverage = tracking.data.coverage;
    const live = tracking.tags.filter((tag) => tag.est && tag.est.confidence !== "lost");
    const accuracy = median(live.map((tag) => tag.est.accuracy));
    const error = median(tracking.check.errors);
    const zoneMatch = tracking.check.zoneScans ? Math.round((tracking.check.zoneHits / tracking.check.zoneScans) * 100) : null;
    const carts = tracking.tags.filter((t) => t.kind === "cart").length;
    const set = (id, value, caption) => { tr$(id).textContent = value; if (caption != null) tr$(`${id}-caption`).textContent = caption; };
    if (!tr$("tracking-stat-beacons")) {
        tr$("tracking-stats").replaceChildren(
            trackingTile("Beacons", "", "", "tracking-stat-beacons"),
            trackingTile("Tracked", "", "", "tracking-stat-tags"),
            trackingTile("Median accuracy", "", "", "tracking-stat-accuracy"),
            trackingTile("Actual error (sim)", "", "", "tracking-stat-error"));
    }
    set("tracking-stat-beacons", `${tracking.signal.beacons.length}`, `${Math.round(coverage.share_3plus * 100)}% of the floor hears 3+`);
    set("tracking-stat-tags", `${live.length} / ${tracking.tags.length}`, `${carts} carts · ${tracking.tags.length - carts} staff`);
    set("tracking-stat-accuracy", accuracy == null ? "—" : `±${metres(accuracy)}`, `68% circle · ${tracking.signal.calibrated ? "calibrated radio map" : "uncalibrated"}`);
    set("tracking-stat-error", error == null ? "—" : metres(error), zoneMatch == null ? "median, vs true position" : `median · zone right ${zoneMatch}% of scans`);
}

function renderTrackingLive(force = false) {
    // The picking tab's cart detail shows the cart's beacon position too.
    const fix = tr$("picking-beacon-fix");
    if (fix && trackingReady()) fix.lastElementChild.textContent = cartFixText(fix.dataset.cartId) || "waiting for the first scan…";
    if (!trackingActive() || !trackingReady()) return;
    tr$("tracking-clock").textContent = !tracking.running ? `Paused · ${simClock()}`
        : tracking.speed === 1 ? `Real time · ${simClock()}` : `Fast-forward ${tracking.speed}× · ${simClock()}`;
    renderTrackingStats();
    updateTagRows();
    renderTagDetail();
    renderScans();
    renderEvents(force);
    renderZoneTime();
    renderBeaconTable();
}

function renderTrackingPanel() {
    const message = tr$("tracking-message");
    const content = tr$("tracking-content");
    const text = !state.currentStoreId ? "Select a store to track carts and staff."
        : tracking.loading ? "Loading beacons…"
        : tracking.error || (!tracking.data ? "No beacon layout for this store." : !trackingReady() ? "No walking network for this store." : "");
    message.textContent = text;
    message.hidden = !text;
    content.hidden = Boolean(text);
    if (text) return;
    tr$("tracking-play").textContent = tracking.running ? "Pause" : "Play";
    tr$("tracking-play").setAttribute("aria-pressed", String(!tracking.running));
    for (const button of document.querySelectorAll("#tracking-speed button")) button.setAttribute("aria-pressed", String(Number(button.dataset.speed) === tracking.speed));
    tr$("tracking-show-beacons").checked = tracking.show.beacons;
    tr$("tracking-show-range").checked = tracking.show.range;
    tr$("tracking-show-truth").checked = tracking.show.truth;
    tr$("tracking-auto-scan").checked = tracking.autoScan;
    tr$("tracking-calibrated").checked = tracking.signal.calibrated;
    const m = tracking.data.model;
    tr$("tracking-note").textContent = `${tracking.data.notice} ${tracking.signal.beacons.length} beacons at ${m.mount_height_m} m, ${m.tx_power_dbm} dBm at 1 m, path-loss exponent ${m.path_loss_exponent}; `
        + `shelving, per-beacon power spread (±2 dB), shadowing (${m.shadowing_sigma_db} dB) and scan noise are simulated. Positions come from the readings alone: a particle filter on the walking floor `
        + `using ${tracking.signal.calibrated ? "the calibrated radio map (what a site survey measures)" : "nominal path loss only (no survey)"}. No GPS works indoors.`;
    renderTrackingLive(true);
}

function selectTag(tagId) {
    tracking.selectedTagId = tagId || null;
    const tag = tracking.tags.find((t) => t.id === tracking.selectedTagId);
    if (tag?.est && state.map) {
        const center = trackingToMap(tag.est.x, tag.est.y);
        const bounds = state.map.getBounds();
        if (!bounds.contains(center) || state.map.getZoom() < TAG_FOCUS_ZOOM - 0.5) state.map.easeTo({ center, zoom: Math.max(state.map.getZoom(), TAG_FOCUS_ZOOM), duration: 600 });
    }
    renderTrackingMap();
    renderTrackingLive(true);
}

function focusEvent(event) {
    if (event.tagId) {
        tracking.selectedTagId = event.tagId;
        renderTrackingMap();
        renderTrackingLive(true);
    }
    if (event.at && state.map) state.map.easeTo({ center: trackingToMap(event.at[0], event.at[1]), zoom: Math.max(state.map.getZoom(), 19.5), duration: 500 });
}

/* ---------------------------------------------------------------------- */
/* Store lifecycle                                                         */
/* ---------------------------------------------------------------------- */

function resetTracking() {
    stopTrackingLoop();
    hideTrackingMarkers();
    Object.assign(tracking, {
        storeId: null, data: null, floor: null, signal: null, network: null, loading: false, error: "",
        tags: [], selectedTagId: null, events: [], eventId: 0, renderedEvents: null, beaconMarkers: [], rackPoints: [], zoneCells: {},
        simTime: 0, nextScan: 0, rows: null, scanSignature: "",
    });
    tracking.zoneTime = new Map();
    tracking.verifications = new Map();
    tracking.check = { errors: [], zoneHits: 0, zoneScans: 0 };
    const detail = tr$("tracking-tag-detail");
    if (detail) delete detail.dataset.tagId;
    const beacons = tr$("tracking-beacon-body");
    if (beacons) delete beacons.dataset.storeId;
    state.map?.getSource(TRACKING_SOURCE)?.setData(emptyCollection());
    state.map?.getSource(TRACKING_RANGE_SOURCE)?.setData(emptyCollection());
}

function startTracking() {
    const network = tracking.network;
    tracking.floor = new BeaconSim.Floor(network, tracking.data);
    tracking.random = BeaconSim.mulberry32(BeaconSim.seedOf(`tracking-${tracking.storeId}`));
    tracking.signal = new BeaconSim.SignalModel(tracking.floor, tracking.data, tracking.random);
    const dispatch = dispatchCell();
    tracking.rackPoints = Object.entries(network.rackAccess)
        .filter(([, cell]) => dispatch == null || network.connected(dispatch, cell))
        .map(([rackId, cell]) => { const [x, y] = tracking.floor.cellXY(cell); return { rackId, cell, x, y }; });
    tracking.zoneCells = {};
    for (const beacon of tracking.data.beacons) if (beacon.zone_type) tracking.zoneCells[beacon.zone_type] = beacon.cell;
    if (dispatch != null) tracking.zoneCells.dispatch = dispatch;
    tracking.clockBase = Date.now();
    tracking.tags = buildTags();
    buildBeaconMarkers();
    buildTagMarkers();
    state.map?.getSource(TRACKING_RANGE_SOURCE)?.setData(rangeData());
    addEvent("signal", null, `Tracking started · ${tracking.data.beacons.length} beacons`, `${tracking.tags.length} tags: ${tracking.tags.map((t) => t.name).join(", ")}`);
    advanceTracking(1.01);         // first scan, so every tag has a position
    syncTrackingLoop();
}

async function loadTracking(store) {
    const generation = ++tracking.generation;
    resetTracking();
    Object.assign(tracking, { storeId: store.store_id, loading: true });
    renderTrackingPanel();
    try {
        const [data] = await Promise.all([BeaconSim.load(store.store_id), picking.loadingPromise?.catch(() => null)]);
        if (generation !== tracking.generation) return;
        tracking.data = data;
        tracking.network = picking.storeId === store.store_id ? picking.network : null;
    } catch (error) {
        console.error(`Beacon tracking ${store.store_id}:`, error);
        if (generation === tracking.generation) tracking.error = "Beacon tracking could not be loaded.";
    }
    if (generation !== tracking.generation) return;
    tracking.loading = false;
    if (tracking.data && tracking.network) startTracking();
    raiseTrackingLayers();
    renderTrackingPanel();
    renderTrackingMap();
}

// Called by the store map once a store's inventory is ready (inventory.js).
function onBeaconStoreReady(store, alignedData, sourceData) {
    ensureTrackingLayers();
    tracking.toMap = makePickingAligner(store, sourceData);
    if (tracking.storeId !== store.store_id) {
        loadTracking(store);
        return;
    }
    // Same store re-drawn (alignment may have changed): move the beacons and range circles.
    if (tracking.data && tracking.signal) {
        buildBeaconMarkers();
        state.map.getSource(TRACKING_RANGE_SOURCE)?.setData(rangeData());
    }
    renderTrackingMap();
}

function hideTrackingMarkers() {
    for (const marker of [...tracking.beaconMarkers, ...tracking.tags.map((tag) => tag.marker).filter(Boolean)]) {
        marker.remove();
        marker.shown = false;
    }
}

function clearBeaconTracking() {
    if (!tracking.layersReady) return;
    hideTrackingMarkers();
    state.map.getSource(TRACKING_SOURCE)?.setData(emptyCollection());
    if (tracking.storeId && tracking.storeId !== state.currentStoreId) {
        ++tracking.generation;
        resetTracking();
        renderTrackingPanel();
    }
}

// Called when the panel's tab changes (picking-workflow.js).
function onTrackingTabChanged(tab) {
    if (tab === "tracking") raiseTrackingLayers();
    syncTrackingLoop();
    renderTrackingPanel();
    renderTrackingMap();
}

function wireTrackingPanel() {
    tr$("tracking-play").addEventListener("click", () => { tracking.running = !tracking.running; renderTrackingPanel(); });
    // Map key: zoom in on the selected person, else the staff member with the widest circle (easiest to see).
    tr$("tracking-zoom-person").addEventListener("click", () => {
        const staff = tracking.tags.filter((tag) => tag.kind === "staff" && tag.est).sort((a, b) => b.est.accuracy - a.est.accuracy);
        const tag = tracking.tags.find((t) => t.id === tracking.selectedTagId) || staff[0] || tracking.tags[0];
        if (!tag) return;
        tracking.selectedTagId = null;
        selectTag(tag.id);
    });
    for (const button of document.querySelectorAll("#tracking-speed button")) {
        button.addEventListener("click", () => { tracking.speed = Number(button.dataset.speed); renderTrackingPanel(); });
    }
    const toggle = (id, apply) => tr$(id).addEventListener("change", (event) => { apply(event.target.checked); renderTrackingMap(); renderTrackingLive(true); });
    toggle("tracking-show-beacons", (on) => { tracking.show.beacons = on; });
    toggle("tracking-show-range", (on) => { tracking.show.range = on; });
    toggle("tracking-show-truth", (on) => { tracking.show.truth = on; });
    toggle("tracking-auto-scan", (on) => { tracking.autoScan = on; });
    toggle("tracking-calibrated", (on) => {
        if (!tracking.signal) return;
        tracking.signal.calibrated = on;
        tracking.check = { errors: [], zoneHits: 0, zoneScans: 0 };   // the simulation check restarts for the new model
        addEvent("signal", null, on ? "Positioning uses the calibrated radio map" : "Positioning uses nominal path loss (uncalibrated)",
            on ? "As after a site survey: expected signal measured per spot, per beacon." : "No survey: shelving and each beacon's actual power are unknown to the engine.");
        renderTrackingPanel();
    });
    for (const button of document.querySelectorAll("#tracking-event-filter button")) {
        button.addEventListener("click", () => { tracking.eventFilter = button.dataset.filter; renderEvents(true); });
    }
}

document.addEventListener("DOMContentLoaded", wireTrackingPanel);

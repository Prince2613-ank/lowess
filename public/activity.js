/* ==========================================================================
 * Picking activity heatmap (the "Activity" tab).
 *
 * Loads frontend/data/activity/<store>.json (scripts/build_picking_activity.py):
 *   - weekly pick lines per rack for the last 12 weeks (from the simulated
 *     sales history), shown as rack colour - a one-hue blue ramp in five
 *     classes (quintiles of the period's picks);
 *   - cart traffic from simulated cart trips on the store's walking network,
 *     as cart passes per week per 1 m cell, shown as a heat layer on a green ->
 *     light green -> yellow -> orange -> red scale.
 * The tab ranks the busiest aisles and racks; click one to zoom to it.
 * ========================================================================== */

const ACTIVITY_RACK_LAYER = "activity-rack-fill";
const ACTIVITY_HEAT_LAYER = "activity-traffic-heat";
const ACTIVITY_HEAT_SOURCE = "activity-traffic";
const ACTIVITY_PERIODS = [1, 4, 12];          // weeks
// Sequential blue (documented ramp steps 150 / 250 / 350 / 450 / 600); zero picks stay neutral.
const ACTIVITY_RAMP = ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#184f95"];
const ACTIVITY_NONE = "#eef2f7";
const activityRackColor = () => {
    const level = ["coalesce", ["feature-state", "activity"], 0];
    return ["match", level, 1, ACTIVITY_RAMP[0], 2, ACTIVITY_RAMP[1], 3, ACTIVITY_RAMP[2], 4, ACTIVITY_RAMP[3], 5, ACTIVITY_RAMP[4], ACTIVITY_NONE];
};
// Cart-traffic heat: green -> light green -> yellow -> orange -> red (semantic heat scale, always shown with its legend).
const ACTIVITY_HEAT = ["rgba(34,197,94,0)", "rgba(34,197,94,0.75)", "#a3e635", "#facc15", "#f97316", "#dc2626"];

const activity = {
    storeId: null,
    data: null,
    loading: false,
    error: "",
    generation: 0,
    weeks: 4,
    showRacks: true,
    showTraffic: true,
    toMap: null,
    layersReady: false,
    rackFids: new Set(),
    breaks: [],
    rackTotals: new Map(),
};

const ac$ = (id) => document.getElementById(id);
const acNumber = new Intl.NumberFormat("en-US");
const activityActive = () => typeof picking !== "undefined" && picking.tab === "activity";

/* Figures --------------------------------------------------------------------- */

function activityRackTotals() {
    const totals = new Map();
    for (const [rackId, weekly] of Object.entries(activity.data?.rack_lines || {})) {
        totals.set(rackId, weekly.slice(-activity.weeks).reduce((sum, v) => sum + v, 0));
    }
    return totals;
}

// Quintile class boundaries of the racks that were picked in the period.
function activityBreaks(totals) {
    const values = [...totals.values()].filter((v) => v > 0).sort((a, b) => a - b);
    if (!values.length) return [];
    return [0.2, 0.4, 0.6, 0.8].map((q) => values[Math.min(values.length - 1, Math.floor(q * values.length))]);
}

const activityClass = (value) => (value <= 0 ? 0 : 1 + activity.breaks.filter((b) => value > b).length);

function activityAisles(totals) {
    const aisles = new Map();
    for (const [rackId, lines] of totals) {
        const rack = inventory.model?.get(rackId);
        if (!rack || lines <= 0) continue;
        const key = aisleText(rack);
        const entry = aisles.get(key) || { name: key, lines: 0, racks: [], department: rack.department };
        entry.lines += lines;
        entry.racks.push(rackId);
        aisles.set(key, entry);
    }
    return [...aisles.values()].sort((a, b) => b.lines - a.lines);
}

/* Map layers -------------------------------------------------------------------- */

function ensureActivityLayers() {
    const map = state.map;
    if (activity.layersReady || !map || !map.getSource(INVENTORY_SOURCE)) return;
    map.addLayer({
        id: ACTIVITY_RACK_LAYER, type: "fill", source: INVENTORY_SOURCE, filter: ["==", ["get", "visible"], true],
        layout: { visibility: "none" },
        paint: { "fill-color": activityRackColor(), "fill-opacity": 1 },
    }, map.getLayer("inventory-rack-outline") ? "inventory-rack-outline" : undefined);
    map.addSource(ACTIVITY_HEAT_SOURCE, { type: "geojson", data: emptyCollection() });
    map.addLayer({
        id: ACTIVITY_HEAT_LAYER, type: "heatmap", source: ACTIVITY_HEAT_SOURCE, layout: { visibility: "none" },
        paint: {
            "heatmap-weight": ["get", "w"],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 16, 0.8, 19, 1.1, 21, 1.4],
            "heatmap-radius": ["interpolate", ["exponential", 2], ["zoom"], 16, 3, 18, 9, 20, 30, 22, 110],
            "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
                0, ACTIVITY_HEAT[0], 0.08, ACTIVITY_HEAT[1], 0.3, ACTIVITY_HEAT[2], 0.55, ACTIVITY_HEAT[3], 0.8, ACTIVITY_HEAT[4], 1, ACTIVITY_HEAT[5]],
            "heatmap-opacity": 0.85,
        },
    }, map.getLayer("picking-target-fill") ? "picking-target-fill" : map.getLayer("extras-fill") ? "extras-fill" : undefined);
    for (const id of [ACTIVITY_RACK_LAYER, ACTIVITY_HEAT_LAYER]) map.setLayerZoomRange(id, ZOOM.STORE_OVERLAYS, 24);
    activity.layersReady = true;
}

function renderActivityMap() {
    const map = state.map;
    if (!map) return;
    ensureActivityLayers();
    if (!activity.layersReady) return;
    const show = activityActive() && activity.data && inventory.model;
    // Racks stay neutral with "Rack picks" off, so occupancy colours never compete with the traffic heat.
    map.setLayoutProperty(ACTIVITY_RACK_LAYER, "visibility", show ? "visible" : "none");
    map.setPaintProperty(ACTIVITY_RACK_LAYER, "fill-color", activity.showRacks ? activityRackColor() : ACTIVITY_NONE);
    map.setLayoutProperty(ACTIVITY_HEAT_LAYER, "visibility", show && activity.showTraffic ? "visible" : "none");
    if (show) inventory.legend?.setVisible(false);
    const next = new Set();
    if (show) {
        for (const [rackId, lines] of activity.rackTotals) {
            const link = inventory.racks.get(rackId);
            if (!link) continue;
            map.setFeatureState({ source: INVENTORY_SOURCE, id: link.fid }, { activity: activityClass(lines) });
            next.add(link.fid);
        }
    }
    for (const fid of activity.rackFids) if (!next.has(fid)) map.setFeatureState({ source: INVENTORY_SOURCE, id: fid }, { activity: 0 });
    activity.rackFids = next;
}

function activityHeatData() {
    const points = activity.data?.traffic?.points || [];
    const max = points.reduce((m, p) => Math.max(m, p[2]), 0) || 1;
    const toMap = activity.toMap || ((p) => p);
    return { type: "FeatureCollection", features: points.map(([lng, lat, passes]) => ({
        // Square-root scale: traffic piles up at Pack & Dispatch; this keeps busy aisles readable too.
        type: "Feature", properties: { w: Math.sqrt(passes / max) }, geometry: { type: "Point", coordinates: toMap([lng, lat]) },
    })) };
}

/* Panel ------------------------------------------------------------------------- */

function activityTile(label, value, caption) {
    return h("div", { className: "activity-stat" }, h("strong", {}, value), h("span", {}, label), caption ? h("small", {}, caption) : null);
}

function zoomToRacks(rackIds) {
    let bounds = null;
    for (const id of rackIds) {
        const link = inventory.racks.get(id);
        if (!link) continue;
        bounds = bounds ? bounds.extend(link.bounds) : new maplibregl.LngLatBounds(link.bounds.getSouthWest(), link.bounds.getNorthEast());
    }
    if (bounds) state.map.fitBounds(padBounds(bounds, 0.4), { maxZoom: 20, padding: 60, duration: 600 });
}

function renderActivityLegend() {
    const classes = [0, ...activity.breaks];
    const label = (i) => {
        const low = i === 0 ? 1 : Math.floor(activity.breaks[i - 1]) + 1;
        const high = i < activity.breaks.length ? Math.floor(activity.breaks[i]) : null;
        return high == null ? `${acNumber.format(low)}+` : low >= high ? acNumber.format(high) : `${acNumber.format(low)}–${acNumber.format(high)}`;
    };
    const traffic = activity.data.traffic;
    const maxPasses = (traffic.points || []).reduce((m, p) => Math.max(m, p[2]), 0);
    setChildren(ac$("activity-legend"),
        h("div", { className: "activity-legend-block" },
            h("div", { className: "activity-legend-title" }, `Rack picks · lines in ${activity.weeks === 1 ? "the last week" : `${activity.weeks} weeks`}`),
            h("div", { className: "activity-legend-row" },
                h("span", {}, h("i", { style: { background: ACTIVITY_NONE } }), "None"),
                ...classes.map((_, i) => h("span", {}, h("i", { style: { background: ACTIVITY_RAMP[i] } }), label(i))))),
        h("div", { className: "activity-legend-block" },
            h("div", { className: "activity-legend-title" }, "Cart traffic · passes per week (square-root scale)"),
            h("div", { className: "activity-heat-scale", style: { background: `linear-gradient(90deg, ${ACTIVITY_HEAT.slice(1).join(", ")})` } }),
            h("div", { className: "activity-heat-ends" }, h("span", {}, "Low"), h("span", {}, `${acNumber.format(Math.round(maxPasses))} at the busiest spot`))));
}

function renderActivityPanel() {
    const message = ac$("activity-message");
    const content = ac$("activity-content");
    for (const button of document.querySelectorAll("#activity-period button")) button.setAttribute("aria-pressed", String(Number(button.dataset.weeks) === activity.weeks));
    const text = !state.currentStoreId ? "Select a store to see its picking activity."
        : activity.loading ? "Loading picking activity…"
        : activity.error || (!activity.data ? "No picking activity for this store." : "");
    message.textContent = text;
    message.hidden = !text;
    content.hidden = Boolean(text);
    if (text) return;

    const totals = activity.rackTotals;
    const lines = [...totals.values()].reduce((s, v) => s + v, 0);
    const aisles = activityAisles(totals);
    const traffic = activity.data.traffic;
    const kmPerWeek = traffic.trips_per_week * traffic.trip_m_mean / 1000;
    ac$("activity-stats").replaceChildren(
        activityTile("Pick lines", acNumber.format(Math.round(lines)), activity.weeks === 1 ? "last week" : `last ${activity.weeks} weeks`),
        activityTile("Busiest aisle", aisles[0]?.name || "—", aisles[0] ? `${Math.round(aisles[0].lines / lines * 100)}% of lines` : null),
        activityTile("Cart trips", acNumber.format(Math.round(traffic.trips_per_week)), "per week"),
        activityTile("Walked by carts", `${acNumber.format(Math.round(kmPerWeek))} km`, `per week · ${acNumber.format(Math.round(traffic.trip_m_mean))} m a trip`));
    renderActivityLegend();

    const top = aisles.slice(0, 10);
    const max = top[0]?.lines || 1;
    ac$("activity-aisles").replaceChildren(...top.map((aisle) => h("button", {
        type: "button", className: "activity-bar-row", title: `${aisle.name} · ${aisle.department}: ${acNumber.format(Math.round(aisle.lines))} lines over ${aisle.racks.length} racks`,
        onClick: () => zoomToRacks(aisle.racks),
    },
        h("span", { className: "activity-bar-label" }, aisle.name),
        h("span", { className: "activity-bar-track" }, h("span", { className: "activity-bar", style: { width: `${aisle.lines / max * 100}%` } })),
        h("span", { className: "activity-bar-value" }, acNumber.format(Math.round(aisle.lines))))));

    const racks = [...totals].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 15);
    ac$("activity-racks").replaceChildren(...racks.map(([rackId, value]) => {
        const rack = inventory.model.get(rackId);
        return h("tr", { tabindex: "0", onClick: () => selectRack(rackId, { zoom: true }),
            onKeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRack(rackId, { zoom: true }); } } },
            h("td", { className: "rack" }, rackId),
            h("td", { title: rack ? rackPlace(rack) : "" }, rack ? rackPlace(rack) : "—"),
            h("td", { className: "num" }, acNumber.format(Math.round(value))),
            h("td", { className: "num" }, `${(value / lines * 100).toFixed(1)}%`));
    }));
    ac$("activity-note").textContent = `${activity.data.notice} ${acNumber.format(traffic.trips_simulated)} cart trips simulated from Pack & Dispatch, scaled to ${acNumber.format(Math.round(traffic.trips_per_week))} a week.`;
}

function refreshActivity() {
    if (activity.data) {
        activity.rackTotals = activityRackTotals();
        activity.breaks = activityBreaks(activity.rackTotals);
    }
    if (activityActive()) renderActivityPanel();
    renderActivityMap();
}

/* Loading & hooks ---------------------------------------------------------------- */

async function loadActivity() {
    const storeId = state.currentStoreId;
    if (!storeId || (activity.storeId === storeId && (activity.data || activity.loading))) return;
    const generation = ++activity.generation;
    Object.assign(activity, { storeId, data: null, loading: true, error: "" });
    renderActivityPanel();
    try {
        const response = await fetch(`data/activity/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
        if (generation !== activity.generation) return;
        if (response.status === 404) activity.data = null;
        else if (!response.ok) throw new Error(`HTTP ${response.status}`);
        else activity.data = await response.json();
    } catch (error) {
        console.error(`Activity ${storeId}:`, error);
        if (generation === activity.generation) activity.error = "Picking activity could not be loaded.";
    }
    if (generation !== activity.generation) return;
    activity.loading = false;
    ensureActivityLayers();
    state.map?.getSource(ACTIVITY_HEAT_SOURCE)?.setData(activityHeatData());
    refreshActivity();
}

// Called by the store map once a store's inventory is ready (inventory.js).
function onActivityStoreReady(store, alignedData, sourceData) {
    activity.toMap = typeof makePickingAligner === "function" ? makePickingAligner(store, sourceData) : null;
    if (activity.storeId !== state.currentStoreId) {
        ++activity.generation;
        Object.assign(activity, { storeId: null, data: null, loading: false, error: "", rackTotals: new Map(), breaks: [] });
        state.map?.getSource(ACTIVITY_HEAT_SOURCE)?.setData(emptyCollection());
    } else if (activity.data) {
        state.map?.getSource(ACTIVITY_HEAT_SOURCE)?.setData(activityHeatData());   // re-aligned
    }
    if (activityActive()) loadActivity(); else renderActivityMap();
}

// Called when the panel's tab changes (picking-workflow.js).
function onActivityTabChanged(tab) {
    if (tab === "activity") {
        if (activity.storeId === state.currentStoreId && activity.data) refreshActivity();
        else loadActivity();
    } else {
        renderActivityMap();
    }
}

function wireActivityPanel() {
    for (const button of document.querySelectorAll("#activity-period button")) {
        button.addEventListener("click", () => { activity.weeks = Number(button.dataset.weeks); refreshActivity(); });
    }
    ac$("activity-show-racks").addEventListener("change", (event) => { activity.showRacks = event.target.checked; renderActivityMap(); });
    ac$("activity-show-traffic").addEventListener("change", (event) => { activity.showTraffic = event.target.checked; renderActivityMap(); });
}

document.addEventListener("DOMContentLoaded", wireActivityPanel);

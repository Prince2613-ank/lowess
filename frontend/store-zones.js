/* ==========================================================================
 * Back-of-house fulfilment areas (staff only): Receiving, Pack & Dispatch and
 * Returns.
 *
 * Loads frontend/data/zones/<store>.json (built by
 * scripts/build_store_zones.py around the map's RECEIVING DESK marker and
 * the back-room racks) and draws each area on the map, aligned like the
 * store map, with the outside doors (dock door for Receiving, driver door for
 * Pack & Dispatch) on the building's outer wall. Map GeoJSON is never modified.
 * ========================================================================== */

const ZONE_SOURCE = "store-zones";
const ZONE_LAYERS = ["store-zones-fill", "store-zones-outline", "store-zone-doors-casing", "store-zone-doors"];
const DOOR_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 21V3h11v1h3v17h2v2H3v-2zm2 0h7V5H7zm9 0h1V6h-1zm-4-8h2v-2h-2z"/></svg>';
const ZONE_STYLES = {
    receiving: { color: "#0f766e", label: "Receiving", door: "Dock door" },
    dispatch: { color: "#b45309", label: "Pack & Dispatch", door: "Driver door" },
    returns: { color: "#be185d", label: "Returns" },
};
const DOOR_TEXT_ZOOM = 17.5;  // door icons gain their name from here in

const storeZones = {
    storeId: null,
    zones: [],
    rackZone: new Map(),
    labels: [],
    layersReady: false,
    generation: 0,
};

async function loadStoreZones(storeId) {
    const response = await fetch(`data/zones/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Zones ${storeId}: HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload.zones) ? payload.zones.filter((zone) => ZONE_STYLES[zone.type] && Array.isArray(zone.polygon)) : [];
}

// The area a rack belongs to (receiving storage), if any.
function zoneForRack(rackId) {
    return storeZones.rackZone.get(rackId) || null;
}

function ensureZoneLayers() {
    if (storeZones.layersReady || !state.map) return;
    const map = state.map;
    map.addSource(ZONE_SOURCE, { type: "geojson", data: emptyCollection() });
    // Under the racks so shelving stays visible on top of the area tint.
    const before = map.getLayer("racks-fill") ? "racks-fill" : map.getLayer("extras-fill") ? "extras-fill" : undefined;
    const areas = ["==", ["geometry-type"], "Polygon"];
    map.addLayer({ id: "store-zones-fill", type: "fill", source: ZONE_SOURCE, filter: areas,
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.16 } }, before);
    map.addLayer({ id: "store-zones-outline", type: "line", source: ZONE_SOURCE, filter: areas,
        layout: { "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": ["case", ["get", "inferred"], ["literal", [2, 2]], ["literal", [1, 0]]] } }, before);
    // Door openings: a thick gap in the area colour on the outer wall, over the racks.
    const doors = ["==", ["geometry-type"], "LineString"];
    const doorWidth = (scale) => ["interpolate", ["exponential", 2], ["zoom"], 17, 4 * scale, 19, 9 * scale, 21, 20 * scale];
    map.addLayer({ id: "store-zone-doors-casing", type: "line", source: ZONE_SOURCE, filter: doors,
        layout: { "line-cap": "butt" }, paint: { "line-color": "#ffffff", "line-width": doorWidth(1.6) } });
    map.addLayer({ id: "store-zone-doors", type: "line", source: ZONE_SOURCE, filter: doors,
        layout: { "line-cap": "butt" }, paint: { "line-color": ["get", "color"], "line-width": doorWidth(1) } });
    map.on("click", "store-zones-fill", (event) => {
        // A rack click opens the rack, not the area.
        if (map.getLayer("inventory-rack-fill") && map.queryRenderedFeatures(event.point, { layers: ["inventory-rack-fill"] }).length) return;
        const zone = storeZones.zones.find((z) => z.id === event.features[0]?.properties?.id);
        if (zone) new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(event.lngLat).setDOMContent(zonePopup(zone)).addTo(map);
    });
    const doorText = () => map.getContainer().classList.toggle("doors-named", map.getZoom() >= DOOR_TEXT_ZOOM);
    map.on("zoom", doorText);
    doorText();
    map.on("mouseenter", "store-zones-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "store-zones-fill", () => { map.getCanvas().style.cursor = ""; });
    for (const id of ZONE_LAYERS) map.setLayerZoomRange(id, ZOOM.STORE_OVERLAYS, 24);
    storeZones.layersReady = true;
}

function zonePopup(zone) {
    const racks = zone.rack_ids?.length ? ` · ${zone.rack_ids.length} racks` : "";
    return h("div", { className: "zone-popup" },
        h("div", { className: "zone-popup-title" }, zone.name),
        h("div", {}, `${Number(zone.area_m2).toLocaleString()} m² (${zone.size_m[0]} × ${zone.size_m[1]} m)${racks}`),
        h("div", { className: "zone-popup-note" }, zone.note),
        h("div", { className: "zone-popup-note" }, "Staff only."));
}

function doorPopup(zone) {
    const door = zone.door;
    return h("div", { className: "zone-popup" },
        h("div", { className: "zone-popup-title" }, door.name),
        h("div", {}, `${zone.name} · ${door.width_m} m wide opening`),
        h("div", { className: "zone-popup-note" }, {
            receiving: "Supplier trucks unload here into Receiving.",
            dispatch: "Packed online orders go out here to the delivery driver, and drivers bring returned items back in here to Returns.",
        }[zone.type]),
        h("div", { className: "zone-popup-note" }, door.note),
        h("div", { className: "zone-popup-note" }, "Staff and delivery drivers only."));
}

function doorMarker(zone, toMap) {
    const element = h("button", { type: "button", className: `store-door ${zone.type}`, title: zone.door.name, "aria-label": zone.door.name });
    element.innerHTML = DOOR_ICON;
    element.append(h("span", { className: "store-door-text" }, ZONE_STYLES[zone.type].door));
    element.addEventListener("click", (event) => {
        event.stopPropagation();
        new maplibregl.Popup({ maxWidth: "280px", offset: 14 }).setLngLat(toMap(zone.door.position)).setDOMContent(doorPopup(zone)).addTo(state.map);
    });
    // Sit just outside the wall, on the side the door opens to, so the opening stays visible.
    const [x0, y0] = toMap(zone.door.position), [x1, y1] = toMap(zone.door.outside);
    const dx = (x1 - x0) * Math.cos((y0 * Math.PI) / 180), dy = y1 - y0;
    const anchor = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "left" : "right") : (dy > 0 ? "bottom" : "top");
    return new maplibregl.Marker({ element, anchor }).setLngLat([x1, y1]);
}

function renderStoreZones() {
    if (!storeZones.layersReady) return;
    storeZones.labels.forEach((marker) => marker.remove());
    storeZones.labels = [];
    const visible = document.getElementById("layer-zones")?.checked !== false;
    for (const id of ZONE_LAYERS) state.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    const toMap = storeZones.toMap || ((point) => point);
    const features = storeZones.zones.flatMap((zone) => {
        const properties = { id: zone.id, type: zone.type, color: ZONE_STYLES[zone.type].color, inferred: zone.source === "inferred" };
        const area = { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [zone.polygon.map(toMap)] } };
        return zone.door ? [area, { type: "Feature", properties, geometry: { type: "LineString", coordinates: zone.door.opening.map(toMap) } }] : [area];
    });
    state.map.getSource(ZONE_SOURCE).setData({ type: "FeatureCollection", features });
    if (!visible) return;
    for (const zone of storeZones.zones) {
        const ring = zone.polygon.map(toMap);
        const center = ring.slice(0, -1).reduce((sum, [x, y]) => [sum[0] + x, sum[1] + y], [0, 0]).map((v) => v / (ring.length - 1));
        const label = h("div", { className: `store-zone-label ${zone.type}` },
            ZONE_STYLES[zone.type].label);
        // Receiving sits beside the map's receiving desk icon so they read together;
        // the other areas (and a receiving area placed without a desk marker) are labelled in the middle.
        const marker = zone.type === "receiving" && zone.source === "map_marker"
            ? new maplibregl.Marker({ element: label, anchor: "left", offset: [24, 0] }).setLngLat(toMap(zone.anchor))
            : new maplibregl.Marker({ element: label, anchor: "center" }).setLngLat(zone.type === "receiving" ? center : toMap(zone.anchor));
        storeZones.labels.push(marker.addTo(state.map));
        if (zone.door) storeZones.labels.push(doorMarker(zone, toMap).addTo(state.map));
    }
    if (typeof declutterLabels === "function") declutterLabels();
}

/* Hooks called by the store map (guarded there). */

async function onStoreZonesReady(store, alignedData, sourceData) {
    ensureZoneLayers();
    storeZones.toMap = makePickingAligner(store, sourceData);
    if (storeZones.storeId !== store.store_id) {
        const generation = ++storeZones.generation;
        storeZones.storeId = store.store_id;
        storeZones.zones = [];
        storeZones.rackZone = new Map();
        try {
            const zones = await loadStoreZones(store.store_id);
            if (generation !== storeZones.generation) return;
            storeZones.zones = zones;
            storeZones.rackZone = new Map(zones.flatMap((zone) => (zone.rack_ids || []).map((id) => [id, zone])));
        } catch (error) {
            console.error(`Store zones ${store.store_id}:`, error);
        }
        if (generation !== storeZones.generation) return;
        if (typeof renderDetails === "function" && inventory.selectedId) renderDetails();
    }
    renderStoreZones();
}

function clearStoreZones() {
    if (!storeZones.layersReady) return;
    storeZones.labels.forEach((marker) => marker.remove());
    storeZones.labels = [];
    state.map.getSource(ZONE_SOURCE)?.setData(emptyCollection());
    if (storeZones.storeId && storeZones.storeId !== state.currentStoreId) {
        ++storeZones.generation;
        Object.assign(storeZones, { storeId: null, zones: [], rackZone: new Map() });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("layer-zones")?.addEventListener("change", renderStoreZones);
});

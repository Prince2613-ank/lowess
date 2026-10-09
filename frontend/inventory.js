/* ==========================================================================
 * Rack & Inventory Management dashboard (SIMULATED DEMO DATA).
 *
 * Links InventoryModel records to existing Lowes_rack bays, draws occupancy
 * colours as an overlay above the untouched rack layers and drives the
 * Inventory sidebar. Hooks used by the base app:
 *   onInventoryMapRendered(store, alignedData, sourceData)  - directory.js
 *   clearInventoryLayer()                                    - app.js
 * ========================================================================== */

const INVENTORY_SOURCE = "inventory-racks";
const INVENTORY_LAYERS = ["inventory-rack-halo", "inventory-rack-fill", "inventory-rack-outline"];
const INVENTORY_LABEL_ZOOM = 19;   // MapLibre zoom (Leaflet 20)
const INVENTORY_FOCUS_ZOOM = 20;
const CENTROID_TOLERANCE = 1e-6;   // degrees, ~0.1 m
const MAX_RACK_LABELS = 250;       // labels are only built for racks in view
const LIST_PAGE_SIZE = 100;

const inventory = {
    model: null,
    storeId: null,
    storeName: "",
    generation: 0,
    loading: false,
    error: "",
    racks: new Map(),        // rack_id -> { fid, geometry, center, bounds }
    unlinked: [],
    selectedId: null,
    hoverFid: null,
    filters: { department: "", category: "", band: "", aisle: "" },
    sort: { key: "rack_id", dir: 1 },
    labels: new MarkerGroup(),
    enabled: true,
    layersReady: false,
    hoverPopup: null,
    legend: null,
    editSku: null,
    listLimit: LIST_PAGE_SIZE,
    selectedFid: null,
};

const inv$ = (id) => document.getElementById(id);

// Small DOM builder; all text goes through textContent, so data and user
// input are never parsed as HTML.
function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "className") node.className = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key === "style") Object.assign(node.style, value);
        else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

const formatNumber = (value) => Number(value).toLocaleString();
const aisleText = (rack) => (rack.aisle_id ? `Aisle ${rack.aisle_id}` : "No aisle");
const formatTime = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/* ---------------------------------------------------------------------- */
/* Geometry link                                                           */
/* ---------------------------------------------------------------------- */

// Same formula as scripts/generate_demo_inventory.py ring_centroid().
function ringCentroid(rings) {
    const ring = rings[0];
    const [ox, oy] = ring[0];
    let area = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
        const x0 = ring[i][0] - ox, y0 = ring[i][1] - oy, x1 = ring[i + 1][0] - ox, y1 = ring[i + 1][1] - oy;
        const cross = x0 * y1 - x1 * y0;
        area += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    if (area === 0) return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    return [ox + cx / (3 * area), oy + cy / (3 * area)];
}

function layerCollections(data) {
    return new Map(collectLayers(data).map(([path, collection]) => [path.split("/").pop(), collection]));
}

function rackRings(collections, ref) {
    const geometry = collections.get(ref.layer)?.features?.[ref.feature]?.geometry;
    if (geometry?.type === "MultiPolygon") return geometry.coordinates[ref.part] || null;
    if (geometry?.type === "Polygon" && ref.part === 0) return geometry.coordinates;
    return null;
}

// Resolve every record to its bay in the aligned map, checking the bay in the
// source data is still the one the inventory was generated for.
function linkRacks(records, alignedData, sourceData) {
    inventory.racks.clear();
    inventory.unlinked = [];
    const aligned = layerCollections(alignedData);
    const source = layerCollections(sourceData);
    records.forEach((record, index) => {
        const ref = record.geometry_ref || {};
        const sourceRings = rackRings(source, ref);
        const rings = rackRings(aligned, ref);
        const [lon, lat] = sourceRings ? ringCentroid(sourceRings) : [NaN, NaN];
        const expected = ref.source_centroid || [];
        if (!rings || !(Math.abs(lon - expected[0]) < CENTROID_TOLERANCE && Math.abs(lat - expected[1]) < CENTROID_TOLERANCE)) {
            inventory.unlinked.push(record.rack_id);
            return;
        }
        const geometry = { type: "Polygon", coordinates: rings };
        inventory.racks.set(record.rack_id, {
            fid: index + 1,
            geometry,
            center: ringCentroid(rings),
            bounds: geometryBounds(geometry),
        });
    });
    if (inventory.unlinked.length) console.warn(`[INVENTORY] ${inventory.unlinked.length} racks not linked to map geometry:`, inventory.unlinked.slice(0, 20));
    console.info(`[INVENTORY] ${inventory.racks.size} racks linked for store ${inventory.storeId}`);
}

/* ---------------------------------------------------------------------- */
/* Map overlay                                                             */
/* ---------------------------------------------------------------------- */

function bandColorExpression() {
    const bands = InventoryModel.BANDS;
    return ["match", ["get", "band"], "high", bands.high.color, "partial", bands.partial.color, "low", bands.low.color, bands.vacant.color];
}

function ensureInventoryLayers() {
    if (inventory.layersReady || !state.map) return;
    const map = state.map;
    map.addSource(INVENTORY_SOURCE, { type: "geojson", data: emptyCollection() });
    // Above the original rack layers, below extras and the debug overlay.
    const before = map.getLayer("extras-fill") ? "extras-fill" : undefined;
    const visible = ["==", ["get", "visible"], true];
    map.addLayer({
        id: "inventory-rack-halo", type: "line", source: INVENTORY_SOURCE, filter: visible,
        paint: {
            "line-color": "#2563eb",
            "line-width": 9,
            "line-blur": 3,
            "line-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.55, 0],
        },
    }, before);
    map.addLayer({
        id: "inventory-rack-fill", type: "fill", source: INVENTORY_SOURCE, filter: visible,
        paint: {
            "fill-color": bandColorExpression(),
            "fill-opacity": ["case",
                ["boolean", ["feature-state", "selected"], false], 0.95,
                ["boolean", ["feature-state", "hover"], false], 0.92, 0.78],
        },
    }, before);
    map.addLayer({
        id: "inventory-rack-outline", type: "line", source: INVENTORY_SOURCE, filter: visible,
        paint: {
            "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#1d4ed8", "#111827"],
            "line-width": ["case",
                ["boolean", ["feature-state", "selected"], false], 3,
                ["boolean", ["feature-state", "hover"], false], 2.2, 1],
        },
    }, before);

    inventory.hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "inventory-hover" });
    map.on("mousemove", "inventory-rack-fill", onRackHover);
    map.on("mouseleave", "inventory-rack-fill", clearRackHover);
    map.on("click", "inventory-rack-fill", (event) => {
        const id = event.features?.[0]?.properties?.rack_id;
        if (id) selectRack(id, { zoom: false, scroll: true });
    });
    map.on("moveend", updateRackLabels);

    inventory.legend = new InventoryLegend();
    map.addControl(inventory.legend, "bottom-left");
    inventory.layersReady = true;
    applyInventoryEnabled();
}

function onRackHover(event) {
    const feature = event.features?.[0];
    if (!feature) return;
    if (inventory.hoverFid !== feature.id) {
        clearRackHover();
        inventory.hoverFid = feature.id;
        state.map.setFeatureState({ source: INVENTORY_SOURCE, id: feature.id }, { hover: true });
    }
    const rack = inventory.model?.get(feature.properties.rack_id);
    if (!rack) return;
    inventory.hoverPopup.setLngLat(event.lngLat).setDOMContent(h("div", {},
        h("strong", {}, rack.rack_id), ` · ${aisleText(rack)} · ${rack.department}`,
        h("div", {}, `${rack.occupancy_percentage}% occupied · ${formatNumber(rack.available_capacity)} slots free`),
    )).addTo(state.map);
}

function clearRackHover() {
    if (inventory.hoverFid != null && state.map.getSource(INVENTORY_SOURCE)) {
        state.map.setFeatureState({ source: INVENTORY_SOURCE, id: inventory.hoverFid }, { hover: false });
    }
    inventory.hoverFid = null;
    inventory.hoverPopup?.remove();
}

function rackIsShown(rack) {
    return inventory.model.matchesFilters(rack, inventory.filters) || rack.rack_id === inventory.selectedId;
}

function renderInventoryMap() {
    if (!inventory.layersReady) return;
    const features = [];
    for (const rack of inventory.model ? inventory.model.list() : []) {
        const link = inventory.racks.get(rack.rack_id);
        if (!link) continue;
        features.push({
            type: "Feature",
            id: link.fid,
            geometry: link.geometry,
            properties: { rack_id: rack.rack_id, band: rack.occupancy_band, occupancy: rack.occupancy_percentage, visible: rackIsShown(rack) },
        });
    }
    state.map.getSource(INVENTORY_SOURCE)?.setData({ type: "FeatureCollection", features });
    applySelectionState();
    updateRackLabels();
}

function applySelectionState() {
    if (!inventory.layersReady) return;
    const fid = inventory.racks.get(inventory.selectedId)?.fid ?? null;
    if (inventory.selectedFid != null && inventory.selectedFid !== fid) {
        state.map.setFeatureState({ source: INVENTORY_SOURCE, id: inventory.selectedFid }, { selected: false });
    }
    if (fid != null) state.map.setFeatureState({ source: INVENTORY_SOURCE, id: fid }, { selected: true });
    inventory.selectedFid = fid;
}

// Rack ID labels appear when zoomed in, only for racks in view, and never on
// top of the store's own labels, icons or each other (the selected rack always
// shows).
function updateRackLabels() {
    if (!state.map) return;
    inventory.labels.clearLayers();
    const show = inventory.enabled && inventory.model && state.map.getZoom() >= INVENTORY_LABEL_ZOOM;
    if (!show) return;
    const view = state.map.getBounds();
    const middle = state.map.getCenter();
    const inView = [];
    for (const [id, link] of inventory.racks) {
        const rack = inventory.model.get(id);
        if (!view.contains(link.center) || !rackIsShown(rack)) continue;
        inView.push({ rack, link, distance: id === inventory.selectedId ? -1 : Math.hypot(link.center[0] - middle.lng, link.center[1] - middle.lat) });
    }
    inView.sort((a, b) => a.distance - b.distance);
    for (const { rack, link } of inView.slice(0, MAX_RACK_LABELS)) {
        const label = h("div", { className: `inventory-rack-label band-${rack.occupancy_band}` }, rack.rack_id);
        const marker = new maplibregl.Marker({ element: label, anchor: "center" }).setLngLat(link.center);
        marker.rackId = rack.rack_id;
        inventory.labels.addLayer(marker);
    }
    inventory.labels.setVisible(true);
    requestAnimationFrame(() => {
        const container = state.map.getCanvasContainer();
        const taken = [...container.querySelectorAll(".dept-label, .aisle-label, .rack-label, .marker-icon")]
            .map((node) => node.getBoundingClientRect())
            .filter((rect) => rect.width && rect.height);
        const overlaps = (a) => taken.some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
        const shown = inventory.labels.getLayers().filter((marker) => marker._shown)
            .sort((a, b) => (b.rackId === inventory.selectedId) - (a.rackId === inventory.selectedId));
        for (const marker of shown) {
            const element = marker.getElement();
            element.style.visibility = "visible";
            element.classList.toggle("selected", marker.rackId === inventory.selectedId);
            const rect = element.getBoundingClientRect();
            if (marker.rackId !== inventory.selectedId && overlaps(rect)) element.style.visibility = "hidden";
            else taken.push(rect);
        }
    });
}

function applyInventoryEnabled() {
    if (!inventory.layersReady) return;
    for (const id of INVENTORY_LAYERS) state.map.setLayoutProperty(id, "visibility", inventory.enabled ? "visible" : "none");
    inventory.legend?.setVisible(inventory.enabled);
    if (!inventory.enabled) clearRackHover();
    updateRackLabels();
}

class InventoryLegend {
    onAdd() {
        const items = Object.entries(InventoryModel.BANDS).map(([key, band]) =>
            h("li", {}, h("span", { className: "inventory-swatch", style: { background: band.color } }),
                key === "high" ? "> 70%" : key === "partial" ? "30–70%" : key === "low" ? "< 30%" : "Vacant"));
        this.container = h("div", { className: "maplibregl-ctrl inventory-legend", role: "group", "aria-label": "Rack occupancy legend" },
            h("div", { className: "inventory-legend-title" }, "Rack occupancy"),
            h("ul", {}, items));
        return this.container;
    }

    onRemove() {
        this.container.remove();
    }

    setVisible(visible) {
        if (this.container) this.container.hidden = !visible;
    }
}

/* ---------------------------------------------------------------------- */
/* Store lifecycle hooks                                                   */
/* ---------------------------------------------------------------------- */

async function onInventoryMapRendered(store, alignedData, sourceData) {
    ensureInventoryLayers();
    const storeId = store.store_id;
    if (inventory.storeId !== storeId) {
        const generation = ++inventory.generation;
        Object.assign(inventory, { storeId, storeName: store.name || "", model: null, selectedId: null, error: "", loading: true });
        inventory.filters = { department: "", category: "", band: "", aisle: "" };
        inventory.listLimit = LIST_PAGE_SIZE;
        inventory.selectedFid = null;
        inv$("inventory-search").value = "";
        renderInventoryPanel();
        let model = null;
        try {
            model = await InventoryModel.load(storeId);
        } catch (error) {
            console.error(`Inventory ${storeId}:`, error);
            if (generation === inventory.generation) inventory.error = "Inventory could not be loaded.";
        }
        if (generation !== inventory.generation) return;
        inventory.model = model;
        inventory.loading = false;
        renderFilterOptions();
    }
    if (!inventory.model) {
        inventory.racks.clear();
        renderInventoryMap();
        renderInventoryPanel();
        return;
    }
    linkRacks(inventory.model.list(), alignedData, sourceData);
    renderInventoryMap();
    renderInventoryPanel();
}

function clearInventoryLayer() {
    if (!inventory.layersReady) return;
    clearRackHover();
    inventory.labels.clearLayers();
    inventory.racks.clear();
    state.map.getSource(INVENTORY_SOURCE)?.setData(emptyCollection());
    if (inventory.storeId && inventory.storeId !== state.currentStoreId) {
        // Another store was chosen; its inventory loads once its map renders.
        ++inventory.generation;
        Object.assign(inventory, { storeId: null, model: null, selectedId: null, loading: false, error: "" });
        renderInventoryPanel();
    }
}

/* ---------------------------------------------------------------------- */
/* Selection                                                               */
/* ---------------------------------------------------------------------- */

function selectRack(id, { zoom = true, scroll = false } = {}) {
    if (!inventory.model?.get(id)) return;
    inventory.selectedId = id;
    renderInventoryMap();
    renderInventoryPanel();
    const link = inventory.racks.get(id);
    if (zoom && link && state.map) {
        state.map.fitBounds(padBounds(link.bounds, 2), { maxZoom: INVENTORY_FOCUS_ZOOM, padding: 60, duration: 600 });
        state.map.once("moveend", updateRackLabels);
    }
    if (scroll) inv$("inventory-details").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clearSelection() {
    inventory.selectedId = null;
    renderInventoryMap();
    renderInventoryPanel();
}

/* ---------------------------------------------------------------------- */
/* Sidebar rendering                                                       */
/* ---------------------------------------------------------------------- */

function statusChip(rack) {
    const band = InventoryModel.BANDS[rack.occupancy_band];
    return h("span", { className: `inventory-chip band-${rack.occupancy_band}`, title: band.detail }, band.label);
}

function stockChip(rack) {
    const kind = rack.inventory_status === "In Stock" ? "ok" : rack.inventory_status === "Low Stock" ? "warn" : "out";
    return h("span", { className: `inventory-stock stock-${kind}` }, rack.inventory_status);
}

function progressBar(rack, compact = false) {
    return h("div", {
        className: `inventory-progress${compact ? " compact" : ""}`, role: "progressbar",
        "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(rack.occupancy_percentage),
        "aria-label": `${rack.rack_id} occupancy`,
    }, h("span", { className: `band-${rack.occupancy_band}`, style: { width: `${Math.min(100, rack.occupancy_percentage)}%` } }));
}

function renderInventoryPanel() {
    inv$("inventory-store").textContent = inventory.storeId ? `${inventory.storeName} · #${inventory.storeId}` : "No store selected";
    const ready = Boolean(inventory.model);
    inv$("inventory-content").hidden = !ready;
    const message = inv$("inventory-message");
    message.hidden = ready && !inventory.unlinked.length;
    message.textContent = inventory.loading ? "Loading inventory…"
        : inventory.error ? inventory.error
        : !inventory.storeId ? "Select a store with an indoor map to manage its racks."
        : !ready ? "No monitored racks for this store."
        : inventory.unlinked.length ? `${inventory.unlinked.length} rack(s) could not be matched to map geometry: ${inventory.unlinked.join(", ")}`
        : "";
    message.classList.toggle("warning", Boolean(ready && inventory.unlinked.length) || Boolean(inventory.error));
    if (!ready) return;
    renderStats();
    renderSearchResults();
    renderDetails();
    renderRackTable();
    inv$("inventory-storage-note").hidden = inventory.model.storageAvailable;
}

function renderStats() {
    const stats = inventory.model.stats();
    const tile = (label, value, note, kind = "") => h("div", { className: `inventory-stat ${kind}` },
        h("span", { className: "inventory-stat-value" }, value),
        h("span", { className: "inventory-stat-label" }, label),
        note ? h("span", { className: "inventory-stat-note" }, note) : null);
    inv$("inventory-stats").replaceChildren(
        tile("Monitored racks", formatNumber(stats.total)),
        tile("Occupied", formatNumber(stats.occupied), "> 70%", "band-high"),
        tile("Partially occupied", formatNumber(stats.partial), "1–70%", "band-partial"),
        tile("Vacant", formatNumber(stats.vacant), "0%", "band-vacant"),
        tile("Utilization", `${stats.utilization}%`, `${formatNumber(stats.occupiedCapacity)} / ${formatNumber(stats.capacity)} slots`),
        tile("Available", formatNumber(stats.available), "free slots"),
    );
}

function renderFilterOptions() {
    const facets = inventory.model?.facets() || { departments: [], categories: [], aisles: [] };
    const fill = (id, values, label, describe = (v) => v) => {
        const select = inv$(id);
        select.replaceChildren(new Option(label, ""), ...values.map((value) => new Option(describe(value), value)));
        select.value = "";
    };
    fill("inventory-filter-department", facets.departments, "All departments");
    fill("inventory-filter-category", facets.categories, "All categories");
    fill("inventory-filter-aisle", facets.aisles, "All aisles", (aisle) => `Aisle ${aisle}`);
    inv$("inventory-filter-band").value = "";
}

function renderSearchResults() {
    const list = inv$("inventory-search-results");
    const query = inv$("inventory-search").value;
    const results = inventory.model && query.trim() ? inventory.model.search(query) : [];
    list.hidden = !query.trim();
    if (!query.trim()) { list.replaceChildren(); return; }
    if (!results.length) { list.replaceChildren(h("li", { className: "empty" }, "No racks match your search")); return; }
    list.replaceChildren(...results.map(({ rack, reason }) => h("li", {},
        h("button", {
            type: "button", className: "inventory-result", dataset: { rackId: rack.rack_id },
            onClick: () => {
                inv$("inventory-search-results").hidden = true;
                selectRack(rack.rack_id, { zoom: true, scroll: true });
            },
        },
        h("span", { className: "inventory-result-title" }, h("strong", {}, rack.rack_id), ` · ${aisleText(rack)} · ${rack.department}`),
        h("span", { className: "inventory-result-meta" }, reason || rack.product_category, " · ", `${rack.occupancy_percentage}% occupied`)))));
}

function renderDetails() {
    const panel = inv$("inventory-details");
    const rack = inventory.selectedId ? inventory.model.get(inventory.selectedId) : null;
    panel.hidden = !rack;
    if (!rack) { panel.replaceChildren(); return; }
    const linked = inventory.racks.has(rack.rack_id);
    const field = (label, value) => h("div", { className: "inventory-field" }, h("dt", {}, label), h("dd", {}, value));
    const productOptions = rack.products.map((product) => new Option(`${product.product_name} (${product.sku})`, product.sku));
    const productSelect = h("select", { id: "inventory-edit-product", "aria-label": "Product", onChange: (event) => { inventory.editSku = event.target.value; } }, productOptions);
    if (rack.products.some((product) => product.sku === inventory.editSku)) productSelect.value = inventory.editSku;
    const quantityInput = h("input", { id: "inventory-edit-quantity", type: "number", min: "1", step: "1", value: "10", "aria-label": "Units" });
    const occupiedInput = h("input", {
        id: "inventory-edit-occupied", type: "number", min: "0", max: String(rack.storage_capacity), step: "1",
        value: String(rack.occupied_capacity), "aria-label": "Occupied slots",
    });
    const status = h("p", { id: "inventory-edit-status", className: "inventory-edit-status", role: "status", "aria-live": "polite" });
    const run = (action) => {
        const result = action();
        if (result.ok) refreshAfterEdit();
        const latest = inv$("inventory-edit-status");
        latest.textContent = result.message;
        latest.classList.toggle("error", !result.ok);
    };
    const units = () => Number(quantityInput.value);

    panel.replaceChildren(
        h("div", { className: "inventory-details-header" },
            h("div", {},
                h("div", { className: "inventory-details-kicker" }, "Rack details"),
                h("h3", { id: "inventory-details-title" }, rack.rack_id)),
            h("div", { className: "inventory-details-chips" }, statusChip(rack), stockChip(rack)),
            h("button", { type: "button", className: "inventory-icon-button", "aria-label": "Close rack details", onClick: clearSelection }, "×")),
        ...(linked ? [] : [h("p", { className: "inventory-warning" }, "This rack could not be located on the current map.")]),
        h("dl", { className: "inventory-fields" },
            field("Department", rack.department),
            field("Aisle", rack.aisle_id || "—"),
            field("Category", rack.product_category),
            field("Last updated", formatTime(rack.last_updated)),
        ),
        h("div", { className: "inventory-capacity" },
            h("div", { className: "inventory-capacity-head" },
                h("strong", {}, `${rack.occupancy_percentage}% occupied`),
                h("span", {}, `${formatNumber(rack.occupied_capacity)} of ${formatNumber(rack.storage_capacity)} slots used · ${formatNumber(rack.available_capacity)} available`)),
            progressBar(rack)),
        h("table", { className: "inventory-products" },
            h("thead", {}, h("tr", {}, h("th", {}, "Product"), h("th", {}, "SKU"), h("th", { className: "num" }, "Stock"))),
            h("tbody", {}, rack.products.map((product) => h("tr", {},
                h("td", {}, product.product_name),
                h("td", { className: "sku" }, product.sku),
                h("td", { className: "num" }, formatNumber(product.stock_quantity))))),
            h("tfoot", {}, h("tr", {}, h("td", { colspan: "2" }, "Total stock (units)"), h("td", { className: "num" }, formatNumber(rack.stock_quantity))))),
        h("div", { className: "inventory-edit" },
            h("div", { className: "inventory-edit-title" }, "Adjust inventory"),
            h("label", { className: "inventory-edit-row" }, h("span", {}, "Product"), productSelect),
            h("div", { className: "inventory-edit-row" },
                h("span", {}, "Units"), quantityInput,
                h("button", { type: "button", id: "inventory-add-stock", onClick: () => run(() => inventory.model.changeStock(rack.rack_id, productSelect.value, units())) }, "Add stock"),
                h("button", { type: "button", id: "inventory-remove-stock", onClick: () => run(() => inventory.model.changeStock(rack.rack_id, productSelect.value, -units())) }, "Remove")),
            h("div", { className: "inventory-edit-row" },
                h("span", {}, "Occupied slots"), occupiedInput,
                h("button", { type: "button", id: "inventory-set-occupied", onClick: () => run(() => inventory.model.setOccupied(rack.rack_id, Number(occupiedInput.value))) }, "Set")),
            h("div", { className: "inventory-edit-actions" },
                h("button", { type: "button", id: "inventory-mark-vacant", onClick: () => run(() => inventory.model.markVacant(rack.rack_id)) }, "Mark vacant"),
                h("button", { type: "button", id: "inventory-reset-rack", disabled: !inventory.model.isModified(rack.rack_id), onClick: () => run(() => inventory.model.resetRack(rack.rack_id)) }, "Reset rack")),
            h("p", { className: "inventory-hint" }, "Stock changes adjust occupied slots by each product's pack size."),
            status),
    );
}

function sortedRacks() {
    const racks = inventory.model.list().filter((rack) => inventory.model.matchesFilters(rack, inventory.filters));
    const { key, dir } = inventory.sort;
    if (key === "occupancy") racks.sort((a, b) => dir * (a.occupancy_percentage - b.occupancy_percentage) || a.rack_id.localeCompare(b.rack_id));
    else if (dir < 0) racks.reverse();
    return racks;
}

function renderRackTable() {
    const racks = sortedRacks();
    inv$("inventory-list-count").textContent = `${racks.length} of ${inventory.model.list().length} racks`;
    for (const button of document.querySelectorAll("#inventory-table [data-sort]")) {
        const active = button.dataset.sort === inventory.sort.key;
        button.closest("th").setAttribute("aria-sort", active ? (inventory.sort.dir > 0 ? "ascending" : "descending") : "none");
        button.querySelector(".sort-indicator").textContent = active ? (inventory.sort.dir > 0 ? "▲" : "▼") : "";
    }
    const body = inv$("inventory-table-body");
    if (!racks.length) {
        body.replaceChildren(h("tr", {}, h("td", { colspan: "6", className: "empty" }, "No racks match the current filters")));
        inv$("inventory-more").hidden = true;
        return;
    }
    const more = inv$("inventory-more");
    more.hidden = racks.length <= inventory.listLimit;
    more.textContent = `Show ${Math.min(LIST_PAGE_SIZE, racks.length - inventory.listLimit)} more racks`;
    body.replaceChildren(...racks.slice(0, inventory.listLimit).map((rack) => h("tr", {
        tabindex: "0",
        className: rack.rack_id === inventory.selectedId ? "selected" : "",
        dataset: { rackId: rack.rack_id },
        "aria-selected": String(rack.rack_id === inventory.selectedId),
        onClick: () => selectRack(rack.rack_id, { zoom: true, scroll: true }),
        onKeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRack(rack.rack_id, { zoom: true, scroll: true }); } },
    },
    h("td", { className: "rack" }, rack.rack_id),
    h("td", {}, rack.aisle_id || "—"),
    h("td", { title: rack.department }, rack.department),
    h("td", { title: rack.product_category }, rack.product_category),
    h("td", { className: "occupancy" }, h("span", {}, `${rack.occupancy_percentage}%`), progressBar(rack, true)),
    h("td", {}, statusChip(rack)))));
}

function refreshAfterEdit() {
    renderInventoryMap();
    renderInventoryPanel();
}

/* ---------------------------------------------------------------------- */
/* Sidebar wiring                                                          */
/* ---------------------------------------------------------------------- */

function setInventoryPanelOpen(open) {
    document.body.classList.toggle("inventory-open", open);
    inv$("inventory-panel").hidden = !open;
    inv$("inventory-open-tab").hidden = open;
    inv$("inventory-collapse").setAttribute("aria-expanded", String(open));
    try { sessionStorage.setItem("map-panel:inventory-panel:open", String(open)); } catch (error) { /* per-tab preference only */ }
    if (state.map) window.setTimeout(() => { state.map.resize(); updateRackLabels(); }, 50);
}

function wireInventoryPanel() {
    let open = window.innerWidth > 1100;
    try {
        const saved = sessionStorage.getItem("map-panel:inventory-panel:open");
        if (saved != null) open = saved === "true";
    } catch (error) { /* default */ }
    setInventoryPanelOpen(open);
    inv$("inventory-collapse").addEventListener("click", () => setInventoryPanelOpen(false));
    inv$("inventory-open-tab").addEventListener("click", () => setInventoryPanelOpen(true));

    const search = inv$("inventory-search");
    search.addEventListener("input", renderSearchResults);
    search.addEventListener("focus", renderSearchResults);
    search.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            const first = inv$("inventory-search-results").querySelector(".inventory-result");
            if (first) { event.preventDefault(); first.click(); }
        } else if (event.key === "Escape") {
            search.value = "";
            renderSearchResults();
        }
    });

    const filterIds = { department: "inventory-filter-department", category: "inventory-filter-category", band: "inventory-filter-band", aisle: "inventory-filter-aisle" };
    for (const [key, id] of Object.entries(filterIds)) {
        inv$(id).addEventListener("change", (event) => {
            inventory.filters[key] = event.target.value;
            inventory.listLimit = LIST_PAGE_SIZE;
            renderInventoryMap();
            renderRackTable();
        });
    }
    inv$("inventory-clear-filters").addEventListener("click", () => {
        inventory.filters = { department: "", category: "", band: "", aisle: "" };
        Object.values(filterIds).forEach((id) => { inv$(id).value = ""; });
        inventory.listLimit = LIST_PAGE_SIZE;
        renderInventoryMap();
        renderRackTable();
    });

    for (const button of document.querySelectorAll("#inventory-table [data-sort]")) {
        button.addEventListener("click", () => {
            const key = button.dataset.sort;
            inventory.sort = { key, dir: inventory.sort.key === key ? -inventory.sort.dir : key === "occupancy" ? -1 : 1 };
            inventory.listLimit = LIST_PAGE_SIZE;
            renderRackTable();
        });
    }

    inv$("inventory-more").addEventListener("click", () => {
        inventory.listLimit += LIST_PAGE_SIZE;
        renderRackTable();
    });

    inv$("inventory-reset-all").addEventListener("click", () => {
        if (!inventory.model) return;
        if (!window.confirm("Restore all racks in this store to their original inventory? Your changes will be discarded.")) return;
        inventory.model.resetAll();
        refreshAfterEdit();
    });

    const toggle = inv$("layer-inventory");
    toggle.addEventListener("change", () => {
        inventory.enabled = toggle.checked;
        applyInventoryEnabled();
    });
    // The base app shows/hides its labels on these; recheck label collisions.
    for (const id of ["layer-department", "layer-aisle", "layer-rack"]) {
        inv$(id).addEventListener("change", updateRackLabels);
    }
    renderInventoryPanel();
}

document.addEventListener("DOMContentLoaded", wireInventoryPanel);

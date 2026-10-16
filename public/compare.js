/* ==========================================================================
 * Store Comparison dashboard.
 *
 * Loads data/metrics/stores.json (scripts/build_store_metrics.py): per store,
 * today's inventory (out-of-stock / low-stock SKUs), the walking distance from
 * Pack & Dispatch to the racks, and a daily order history. One filter row
 * (period, focus store) scopes every tile, chart, the map and the table.
 * ========================================================================== */

const cmp = {
    data: null,
    days: 30,
    focus: "",
    sort: { key: "orders", dir: -1 },
    map: null,
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en-US");
const fmt1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const toDate = (iso) => new Date(`${iso}T12:00:00`);

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "className") node.className = value;
        else if (key === "style") Object.assign(node.style, value);
        else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
}
const shortName = (store) => store.name.replace(/ Store$/, "");

/* Period figures ------------------------------------------------------------ */

function sumRange(values, from, to) {
    let total = 0;
    for (let i = Math.max(0, from); i < to; i += 1) total += values[i];
    return total;
}

// Figures for the last `days` days, and the same length before that.
function periodFigures(store, days, offset = 0) {
    const d = store.daily, end = d.orders.length - offset, start = end - days;
    const orders = sumRange(d.orders, start, end), units = sumRange(d.units, start, end);
    const complete = sumRange(d.complete, start, end), labour = sumRange(d.labour_min, start, end);
    return { orders, units, complete, labourHours: labour / 60, perDay: orders / days,
        productivity: labour ? units / (labour / 60) : 0, fulfillment: orders ? complete / orders : 0 };
}

function computeRows() {
    return cmp.data.stores.map((store) => {
        const now = periodFigures(store, cmp.days), before = periodFigures(store, cmp.days, cmp.days);
        return { store, now, before, inventory: store.inventory, layout: store.layout };
    });
}

function networkFigures(rows, key = "now") {
    const t = rows.reduce((a, r) => ({ orders: a.orders + r[key].orders, units: a.units + r[key].units, complete: a.complete + r[key].complete, labour: a.labour + r[key].labourHours }),
        { orders: 0, units: 0, complete: 0, labour: 0 });
    return { ...t, productivity: t.labour ? t.units / t.labour : 0, fulfillment: t.orders ? t.complete / t.orders : 0 };
}

/* Tooltip ------------------------------------------------------------------ */

function showTooltip(event, title, rows) {
    const tip = $("cmp-tooltip");
    tip.replaceChildren(el("div", { className: "tt-title" }, title),
        ...rows.map(([label, value, key]) => el("div", { className: "tt-row" }, el("span", {}, key ? el("i", { className: `tt-key ${key}` }) : null, label), el("strong", {}, value))));
    tip.hidden = false;
    const rect = event.target.getBoundingClientRect?.() || { left: 0, top: 0, right: 0, bottom: 0 };
    const x = event.clientX ?? rect.right, y = event.clientY ?? rect.top;
    const { width, height } = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - width - 8, x + 14)}px`;
    tip.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, y - height - 10))}px`;
}
const hideTooltip = () => { $("cmp-tooltip").hidden = true; };

/* KPI tiles ----------------------------------------------------------------- */

function delta(now, before, { percent = true, unit = "", digits = 1, upIsGood = true } = {}) {
    if (!before) return el("span", {}, "—");
    const change = percent ? (now - before) / before * 100 : now - before;
    const up = change >= 0;
    const good = up === upIsGood;
    const text = `${up ? "▲" : "▼"} ${up ? "+" : "−"}${Math.abs(change).toFixed(digits)}${percent ? "%" : unit}`;
    return el("span", { className: `${up ? "up" : "down"} ${Math.abs(change) < 0.05 ? "" : good ? "good" : "bad"}` }, text);
}

function renderKpis(rows) {
    const now = networkFigures(rows), before = networkFigures(rows, "before");
    const stock = rows.reduce((a, r) => ({ oos: a.oos + r.inventory.out_of_stock, low: a.low + r.inventory.low_stock, skus: a.skus + r.inventory.skus }), { oos: 0, low: 0, skus: 0 });
    const vs = `vs previous ${cmp.days} days`;
    const tile = (label, value, unit, deltaNode, caption) => el("div", { className: "kpi" },
        el("div", { className: "kpi-label" }, label),
        el("div", { className: "kpi-value" }, value, unit ? el("small", {}, unit) : null),
        el("div", { className: "kpi-delta" }, deltaNode, deltaNode ? ` ${caption}` : caption));
    $("cmp-kpis").replaceChildren(
        tile("Online orders", fmt.format(now.orders), null, delta(now.orders, before.orders), vs),
        tile("Units picked", fmt.format(now.units), null, delta(now.units, before.units), vs),
        tile("Picking productivity", fmt1.format(now.productivity), "units / labour hr", delta(now.productivity, before.productivity), vs),
        tile("Fulfillment rate", `${fmt1.format(now.fulfillment * 100)}%`, null,
            delta(now.fulfillment * 100, before.fulfillment * 100, { percent: false, unit: " pp" }), vs),
        tile("Out-of-stock SKUs", fmt.format(stock.oos), null, null, `today · ${fmt1.format(stock.oos / stock.skus * 100)}% of SKUs · ${fmt.format(stock.low)} low`),
    );
}

/* Bar charts --------------------------------------------------------------- */

function barRow(row, { label, track, value, tooltip }) {
    const focused = cmp.focus === row.store.store_id;
    const node = el("div", {
        className: `bar-row${focused ? " focused" : ""}`, tabindex: "0", role: "listitem",
        "aria-label": `${row.store.name}: ${tooltip.map(([k, v]) => `${k} ${v}`).join(", ")}`,
        onPointermove: (event) => showTooltip(event, row.store.name, tooltip),
        onPointerleave: hideTooltip,
        onFocus: (event) => showTooltip(event, row.store.name, tooltip),
        onBlur: hideTooltip,
        onClick: () => setFocus(cmp.focus === row.store.store_id ? "" : row.store.store_id),
    }, el("span", { className: "bar-label", title: row.store.name }, label), el("div", { className: "bar-track" }, track), el("span", { className: "bar-value" }, value));
    return node;
}

function renderBars(id, rows, buildRow, extra = null) {
    const chart = $(id);
    chart.setAttribute("role", "list");
    chart.classList.toggle("has-focus", Boolean(cmp.focus));
    chart.replaceChildren(...rows.map(buildRow), ...(extra ? [extra] : []));
}

function renderOrders(rows) {
    const sorted = rows.slice().sort((a, b) => b.now.orders - a.now.orders);
    const max = Math.max(...sorted.map((r) => r.now.orders)) || 1;
    renderBars("chart-orders", sorted, (r) => barRow(r, {
        label: shortName(r.store),
        track: el("div", { className: "bar", style: { width: `${r.now.orders / max * 100}%` } }),
        value: fmt.format(r.now.orders),
        tooltip: [["Orders", fmt.format(r.now.orders)], ["Per day", fmt1.format(r.now.perDay)], ["Units", fmt.format(r.now.units)],
            ["vs previous period", r.before.orders ? `${r.now.orders >= r.before.orders ? "+" : "−"}${fmt1.format(Math.abs((r.now.orders - r.before.orders) / r.before.orders * 100))}%` : "—"]],
    }));
}

function renderProductivity(rows) {
    const sorted = rows.slice().sort((a, b) => b.now.productivity - a.now.productivity);
    const network = networkFigures(rows).productivity;
    const max = Math.max(...sorted.map((r) => r.now.productivity), network) * 1.05 || 1;
    const ref = el("div", { className: "ref-line", style: { "--at": String(network / max) } }, el("span", {}, `Network ${fmt1.format(network)}`));
    ref.style.setProperty("--at", String(network / max));
    $("chart-productivity").classList.add("with-ref");
    renderBars("chart-productivity", sorted, (r) => barRow(r, {
        label: shortName(r.store),
        track: el("div", { className: "bar", style: { width: `${r.now.productivity / max * 100}%` } }),
        value: fmt1.format(r.now.productivity),
        tooltip: [["Units / labour hr", fmt1.format(r.now.productivity)], ["Avg walk to a rack", `${fmt.format(Math.round(r.layout.walk_mean_m))} m`],
            ["Labour hours", fmt.format(Math.round(r.now.labourHours))], ["Units picked", fmt.format(r.now.units)]],
    }), ref);
}

function renderFulfillment(rows) {
    const network = networkFigures(rows).fulfillment;
    const withDiff = rows.map((r) => ({ ...r, diff: (r.now.fulfillment - network) * 100 }));
    const sorted = withDiff.sort((a, b) => b.diff - a.diff);
    const span = Math.max(...sorted.map((r) => Math.abs(r.diff)), 0.1);
    renderBars("chart-fulfillment", sorted, (r) => barRow(r, {
        label: shortName(r.store),
        track: el("div", { className: `bar ${r.diff >= 0 ? "pos" : "neg"}`, style: { width: `${Math.abs(r.diff) / span * 50}%` } }),
        value: `${r.diff >= 0 ? "+" : "−"}${Math.abs(r.diff).toFixed(2)} pp`,
        tooltip: [["Fulfillment rate", `${(r.now.fulfillment * 100).toFixed(2)}%`], ["Network", `${(network * 100).toFixed(2)}%`],
            ["Orders short", fmt.format(r.now.orders - r.now.complete)], ["Out-of-stock SKUs", fmt.format(r.inventory.out_of_stock)]],
    }));
}

function renderStockouts(rows) {
    const sorted = rows.slice().sort((a, b) => b.inventory.out_of_stock - a.inventory.out_of_stock);
    const max = Math.max(...sorted.map((r) => r.inventory.out_of_stock + r.inventory.low_stock)) || 1;
    renderBars("chart-stockouts", sorted, (r) => {
        const { out_of_stock: oos, low_stock: low, skus } = r.inventory;
        return barRow(r, {
            label: shortName(r.store),
            track: el("div", { className: "bar-stack", style: { width: `${(oos + low) / max * 100}%` } },
                el("div", { className: "seg critical", style: { width: `${oos / (oos + low) * 100}%` } }),
                el("div", { className: "seg warning", style: { width: `${low / (oos + low) * 100}%` } })),
            value: fmt.format(oos),
            tooltip: [["Out of stock", `${fmt.format(oos)} SKUs`], ["Low stock", `${fmt.format(low)} SKUs`], ["Share out of stock", `${fmt1.format(oos / skus * 100)}%`]],
        });
    });
}

/* Orders per day: line chart with crosshair --------------------------------- */

function renderTrend() {
    const host = $("chart-trend");
    const stores = cmp.data.stores, n = cmp.days;
    const dates = stores[0].daily.date.slice(-n);
    const average = dates.map((_, i) => stores.reduce((sum, s) => sum + s.daily.orders[s.daily.orders.length - n + i], 0) / stores.length);
    const focus = stores.find((s) => s.store_id === cmp.focus);
    const series = [{ name: "Average store", values: average, cls: focus ? "context" : "main", key: focus ? "muted" : "" }];
    if (focus) series.push({ name: focus.name, values: focus.daily.orders.slice(-n), cls: "main", key: "" });
    $("trend-sub").textContent = focus ? `${focus.name} against the average store` : "Average store across the network";
    $("trend-legend").replaceChildren(...series.map((s) => el("span", {}, el("i", { className: `key line ${s.key}` }), s.name)));

    const width = Math.max(320, host.clientWidth || 600), height = 240;
    const pad = { left: 40, right: 12, top: 12, bottom: 26 };
    const maxValue = Math.max(...series.flatMap((s) => s.values));
    const step = maxValue > 200 ? 50 : maxValue > 80 ? 25 : 10;
    const top = Math.ceil(maxValue / step) * step;
    const x = (i) => pad.left + (n === 1 ? 0 : i / (n - 1)) * (width - pad.left - pad.right);
    const y = (v) => pad.top + (1 - v / top) * (height - pad.top - pad.bottom);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Orders per day over the last ${n} days`);
    const add = (tag, attrs, text) => { const node = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); if (text != null) node.textContent = text; svg.append(node); return node; };
    for (let v = 0; v <= top; v += step) {
        add("line", { class: v === 0 ? "axis" : "grid", x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) });
        add("text", { class: "tick", x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" }, compact.format(v));
    }
    const ticks = n <= 7 ? dates.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
    for (const i of ticks) add("text", { class: "tick", x: x(i), y: height - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, shortDate.format(toDate(dates[i])));
    const main = series[series.length - 1];
    if (!focus) add("path", { class: "area", d: `M${x(0)},${y(0)} ${main.values.map((v, i) => `L${x(i)},${y(v)}`).join(" ")} L${x(n - 1)},${y(0)} Z` });
    for (const s of series) add("path", { class: `series ${s.cls}`, d: s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ") });
    const cross = add("line", { class: "crosshair", x1: 0, x2: 0, y1: pad.top, y2: height - pad.bottom, visibility: "hidden" });
    const dots = series.map((s) => add("circle", { class: "dot", r: 4, fill: s.cls === "main" ? "var(--series-1)" : "#94a3b8", visibility: "hidden" }));
    const hit = add("rect", { x: pad.left, y: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom, fill: "transparent", tabindex: "0" });
    const at = (i, event) => {
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        series.forEach((s, k) => { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(s.values[i])); dots[k].setAttribute("visibility", "visible"); });
        showTooltip(event, longDate.format(toDate(dates[i])), series.slice().reverse().map((s) => [s.name, fmt1.format(s.values[i]), s.key || "main"]));
    };
    hit.addEventListener("pointermove", (event) => {
        const box = svg.getBoundingClientRect();
        const px = (event.clientX - box.left) / box.width * width;
        at(Math.max(0, Math.min(n - 1, Math.round((px - pad.left) / (width - pad.left - pad.right) * (n - 1)))), event);
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTooltip(); });
    hit.addEventListener("focus", (event) => at(n - 1, event));
    hit.addEventListener("blur", hideTooltip);
    host.replaceChildren(svg);
}

/* Map ---------------------------------------------------------------------- */

function mapFeatures(rows) {
    const max = Math.max(...rows.map((r) => r.now.orders)) || 1;
    return { type: "FeatureCollection", features: rows.filter((r) => r.store.longitude != null).map((r) => ({
        type: "Feature", id: Number(r.store.store_id),
        properties: { store_id: r.store.store_id, name: r.store.name, orders: r.now.orders, radius: 6 + 12 * Math.sqrt(r.now.orders / max),
            focused: cmp.focus === r.store.store_id, dimmed: Boolean(cmp.focus) && cmp.focus !== r.store.store_id },
        geometry: { type: "Point", coordinates: [r.store.longitude, r.store.latitude] },
    })) };
}

function initMap(rows) {
    const map = new maplibregl.Map({
        container: "cmp-map",
        style: {
            version: 8,
            sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
            layers: [
                { id: "background", type: "background", paint: { "background-color": "#e8eef5" } },
                { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.85, "raster-opacity": 0.7, "raster-contrast": -0.1 } },
            ],
        },
        bounds: storeBounds(rows), fitBoundsOptions: { padding: 40 },
        dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // The card can settle its size after the map starts: follow it, then frame the stores.
    const fit = () => { map.resize(); map.fitBounds(storeBounds(cmp.rows), { padding: 40, duration: 0 }); };
    if (window.ResizeObserver) new ResizeObserver(() => map.resize()).observe(map.getContainer());
    map.on("load", () => {
        fit();
        map.addSource("stores", { type: "geojson", data: mapFeatures(rows) });
        map.addLayer({ id: "stores", type: "circle", source: "stores", paint: {
            "circle-radius": ["get", "radius"],
            "circle-color": ["case", ["get", "dimmed"], "#c9d6e6", "#2a78d6"],
            "circle-opacity": 0.9,
            "circle-stroke-color": ["case", ["get", "focused"], "#063b71", "#ffffff"],
            "circle-stroke-width": ["case", ["get", "focused"], 3, 2],
        } });
        map.on("mousemove", "stores", (event) => {
            map.getCanvas().style.cursor = "pointer";
            const p = event.features[0].properties;
            const row = cmp.rows.find((r) => r.store.store_id === p.store_id);
            showTooltip(event.originalEvent, p.name, [["Orders", fmt.format(row.now.orders)], ["Fulfillment", `${(row.now.fulfillment * 100).toFixed(1)}%`], ["Units / labour hr", fmt1.format(row.now.productivity)]]);
        });
        map.on("mouseleave", "stores", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
        map.on("click", "stores", (event) => { const id = event.features[0].properties.store_id; setFocus(cmp.focus === id ? "" : id); });
    });
    cmp.map = map;
}

function storeBounds(rows) {
    const pts = rows.filter((r) => r.store.longitude != null).map((r) => [r.store.longitude, r.store.latitude]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}

function renderMap(rows) {
    if (!cmp.map) { initMap(rows); return; }
    cmp.map.getSource("stores")?.setData(mapFeatures(rows));
    const focus = rows.find((r) => r.store.store_id === cmp.focus);
    if (focus) cmp.map.easeTo({ center: [focus.store.longitude, focus.store.latitude], zoom: Math.max(cmp.map.getZoom(), 9), duration: 600 });
}

/* Table (every figure on the page) ---------------------------------------- */

const COLUMNS = [
    { key: "store", label: "Store", value: (r) => r.store.name, cell: (r) => el("td", { className: "store" }, r.store.name, el("small", {}, `#${r.store.store_id} · ${r.store.city}`)) },
    { key: "orders", label: "Orders", value: (r) => r.now.orders, cell: (r) => fmt.format(r.now.orders) },
    { key: "perDay", label: "Per day", value: (r) => r.now.perDay, cell: (r) => fmt1.format(r.now.perDay) },
    { key: "change", label: "vs prev.", value: (r) => (r.before.orders ? (r.now.orders - r.before.orders) / r.before.orders : 0),
        cell: (r) => { const c = r.before.orders ? (r.now.orders - r.before.orders) / r.before.orders * 100 : 0; return el("td", { className: c >= 0 ? "good" : "bad" }, `${c >= 0 ? "+" : "−"}${fmt1.format(Math.abs(c))}%`); } },
    { key: "productivity", label: "Units / labour hr", value: (r) => r.now.productivity, cell: (r) => fmt1.format(r.now.productivity) },
    { key: "walk", label: "Avg walk to rack", value: (r) => r.layout.walk_mean_m, cell: (r) => `${fmt.format(Math.round(r.layout.walk_mean_m))} m` },
    { key: "fulfillment", label: "Fulfillment", value: (r) => r.now.fulfillment, cell: (r) => `${(r.now.fulfillment * 100).toFixed(2)}%` },
    { key: "short", label: "Orders short", value: (r) => r.now.orders - r.now.complete, cell: (r) => fmt.format(r.now.orders - r.now.complete) },
    { key: "oos", label: "Out of stock", value: (r) => r.inventory.out_of_stock, cell: (r) => fmt.format(r.inventory.out_of_stock) },
    { key: "low", label: "Low stock", value: (r) => r.inventory.low_stock, cell: (r) => fmt.format(r.inventory.low_stock) },
    { key: "occupancy", label: "Rack occupancy", value: (r) => r.inventory.occupancy_pct, cell: (r) => `${fmt1.format(r.inventory.occupancy_pct)}%` },
    { key: "open", label: "", value: () => 0, cell: (r) => el("td", {}, el("a", { href: `./?store=${encodeURIComponent(r.store.store_id)}` }, "Open map")) },
];

function renderTable(rows) {
    const head = $("cmp-table").querySelector("thead tr");
    head.replaceChildren(...COLUMNS.map((col) => {
        const active = cmp.sort.key === col.key;
        const th = el("th", { scope: "col", "aria-sort": active ? (cmp.sort.dir > 0 ? "ascending" : "descending") : null });
        if (!col.label) return th;
        th.append(el("button", { type: "button", onClick: () => { cmp.sort = { key: col.key, dir: active ? -cmp.sort.dir : col.key === "store" ? 1 : -1 }; renderTable(cmp.rows); } },
            col.label, active ? (cmp.sort.dir > 0 ? " ▲" : " ▼") : ""));
        return th;
    }));
    const col = COLUMNS.find((c) => c.key === cmp.sort.key) || COLUMNS[1];
    const sorted = rows.slice().sort((a, b) => {
        const va = col.value(a), vb = col.value(b);
        return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * cmp.sort.dir;
    });
    $("cmp-table").querySelector("tbody").replaceChildren(...sorted.map((r) => el("tr", { className: cmp.focus === r.store.store_id ? "focused" : null },
        ...COLUMNS.map((c) => { const v = c.cell(r); return v instanceof Node ? v : el("td", {}, v); }))));
}

/* Render / filters ---------------------------------------------------------- */

function render() {
    cmp.rows = computeRows();
    const dates = cmp.data.stores[0].daily.date;
    $("cmp-range").textContent = `${longDate.format(toDate(dates[dates.length - cmp.days]))} – ${longDate.format(toDate(dates[dates.length - 1]))}`;
    for (const button of document.querySelectorAll(".cmp-period button")) button.setAttribute("aria-pressed", String(Number(button.dataset.days) === cmp.days));
    $("cmp-focus").value = cmp.focus;
    renderKpis(cmp.rows);
    renderOrders(cmp.rows);
    renderProductivity(cmp.rows);
    renderFulfillment(cmp.rows);
    renderStockouts(cmp.rows);
    renderTrend();
    renderMap(cmp.rows);
    renderTable(cmp.rows);
}

function setFocus(storeId) {
    cmp.focus = storeId;
    const params = new URLSearchParams(window.location.search);
    if (storeId) params.set("store", storeId); else params.delete("store");
    params.set("days", String(cmp.days));
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    render();
}

function setDays(days) {
    cmp.days = days;
    setFocus(cmp.focus);
}

async function init() {
    const params = new URLSearchParams(window.location.search);
    cmp.days = [7, 30, 90].includes(Number(params.get("days"))) ? Number(params.get("days")) : 30;
    try {
        const response = await fetch("data/metrics/stores.json", { cache: "no-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        cmp.data = await response.json();
    } catch (error) {
        console.error("Store comparison:", error);
        const message = $("cmp-message");
        message.textContent = "Store comparison data could not be loaded.";
        message.hidden = false;
        return;
    }
    cmp.focus = cmp.data.stores.some((s) => s.store_id === params.get("store")) ? params.get("store") : "";
    $("cmp-sub").textContent = `${cmp.data.stores.length} stores · online order volume, picking productivity, stockouts and fulfillment`;
    $("cmp-notice").textContent = cmp.data.notice || "";
    const select = $("cmp-focus");
    for (const store of cmp.data.stores.slice().sort((a, b) => a.name.localeCompare(b.name))) select.add(new Option(`${store.name} · #${store.store_id}`, store.store_id));
    select.addEventListener("change", () => setFocus(select.value));
    for (const button of document.querySelectorAll(".cmp-period button")) button.addEventListener("click", () => setDays(Number(button.dataset.days)));
    let resizeTimer = null;
    window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderTrend, 150); });
    render();
}

document.addEventListener("DOMContentLoaded", init);

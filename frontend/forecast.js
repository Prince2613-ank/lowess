/* ==========================================================================
 * SKU demand forecast (the "Forecast" tab).
 *
 * Loads frontend/data/forecast/<store>.json (scripts/build_demand_forecast.py):
 * per SKU a forecast level (units/day), trend and spread fitted on 90 days of
 * simulated sales, plus the store's weekday pattern. Combined here with each
 * SKU's *current* stock from the Rack Inventory model (picks and edits
 * included), for the chosen horizon (7 / 14 / 30 days):
 *   demand    = sum over the next days of level x e^(trend x day) x weekday factor
 *   run-out   = first day the cumulative demand reaches the stock
 *   chance    = P(demand > stock), normal approximation with the SKU's spread
 *   risk      = high >= 70%, medium >= 30%, out = no stock now
 * Racks are coloured on the map by their worst SKU while the tab is open.
 * ========================================================================== */

const FORECAST_LAYER = "forecast-risk-fill";
const FORECAST_HORIZONS = [7, 14, 30];
const FORECAST_LOOKAHEAD = 60;             // days searched for a run-out date
const FORECAST_PAGE = 60;
const RISK = {
    out: { rank: 3, label: "Out now", color: "#8b97a8" },
    high: { rank: 2, label: "Likely", color: "#d03b3b" },
    medium: { rank: 1, label: "At risk", color: "#fab219" },
    low: { rank: 0, label: "OK", color: "#e2e8f0" },
};

const forecast = {
    storeId: null,
    data: null,
    loading: false,
    error: "",
    generation: 0,
    horizon: 14,
    filters: { query: "", department: "", risk: "atrisk" },
    limit: FORECAST_PAGE,
    selectedSku: null,
    rows: [],
    riskFids: new Set(),
    layerReady: false,
    unsubscribe: null,
};

const fc$ = (id) => document.getElementById(id);
const fcDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fcNumber = new Intl.NumberFormat("en-US");
const forecastActive = () => typeof picking !== "undefined" && picking.tab === "forecast";

/* Maths ---------------------------------------------------------------------- */

function forecastNormalCdf(z) {
    // Abramowitz-Stegun 7.1.26
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

function forecastAddDays(iso, days) {
    const date = new Date(`${iso}T12:00:00`);
    date.setDate(date.getDate() + days);
    return date;
}

// Forecast for one SKU against its current stock.
function forecastOutlook(entry, stock, horizon) {
    const [, , level, trend, spread] = entry;
    const start = forecast.data.history_end, weekday = forecast.data.weekday_index;
    let cumulative = 0, demand = 0, runOut = null;
    for (let day = 1; day <= FORECAST_LOOKAHEAD; day += 1) {
        const factor = weekday[(forecastAddDays(start, day).getDay() + 6) % 7];   // Monday = 0
        cumulative += level * Math.exp(trend * day) * factor;
        if (day === horizon) demand = cumulative;
        if (runOut == null && stock > 0 && cumulative >= stock) runOut = day;
        if (day >= horizon && runOut != null) break;
    }
    if (!demand) demand = cumulative;
    const sd = Math.max(spread * Math.sqrt(horizon), 0.5);
    const chance = stock <= 0 ? 1 : 1 - forecastNormalCdf((stock + 0.5 - demand) / sd);
    const risk = stock <= 0 ? "out" : chance >= 0.7 ? "high" : chance >= 0.3 ? "medium" : "low";
    return { demand, chance, runOut: stock <= 0 ? 0 : runOut, risk, shortfall: Math.max(0, demand - stock) };
}

function computeForecastRows() {
    if (!forecast.data || !inventory.model) return [];
    const products = new Map();
    for (const rack of inventory.model.list()) for (const product of rack.products) products.set(product.sku, { rack, product });
    const rows = [];
    for (const entry of forecast.data.skus) {
        const found = products.get(entry[0]);
        if (!found) continue;
        const stock = found.product.stock_quantity;
        rows.push({ entry, sku: entry[0], rack: found.rack, product: found.product, stock, ...forecastOutlook(entry, stock, forecast.horizon) });
    }
    return rows;
}

/* Map overlay ---------------------------------------------------------------- */

function ensureForecastLayer() {
    const map = state.map;
    if (forecast.layerReady || !map || !map.getSource(INVENTORY_SOURCE)) return;
    const risk = ["coalesce", ["feature-state", "risk"], 0];
    map.addLayer({
        id: FORECAST_LAYER, type: "fill", source: INVENTORY_SOURCE, filter: ["==", ["get", "visible"], true],
        layout: { visibility: "none" },
        paint: {
            "fill-color": ["match", risk, 3, RISK.out.color, 2, RISK.high.color, 1, RISK.medium.color, RISK.low.color],
            "fill-opacity": 1,
        },
    }, map.getLayer("inventory-rack-outline") ? "inventory-rack-outline" : undefined);
    map.setLayerZoomRange(FORECAST_LAYER, ZOOM.STORE_OVERLAYS, 24);
    forecast.layerReady = true;
}

function renderForecastMap() {
    const map = state.map;
    if (!map) return;
    ensureForecastLayer();
    if (!forecast.layerReady) return;
    const show = forecastActive() && forecast.data && inventory.model;
    map.setLayoutProperty(FORECAST_LAYER, "visibility", show ? "visible" : "none");
    inventory.legend?.setVisible(!show && inventory.enabled !== false);
    const worst = new Map();
    if (show) {
        for (const row of forecast.rows) {
            const rank = RISK[row.risk].rank;
            if (rank > (worst.get(row.rack.rack_id) || 0)) worst.set(row.rack.rack_id, rank);
        }
    }
    const next = new Set();
    for (const [rackId, rank] of worst) {
        const link = inventory.racks.get(rackId);
        if (!link) continue;
        map.setFeatureState({ source: INVENTORY_SOURCE, id: link.fid }, { risk: rank });
        next.add(link.fid);
    }
    for (const fid of forecast.riskFids) if (!next.has(fid)) map.setFeatureState({ source: INVENTORY_SOURCE, id: fid }, { risk: 0 });
    forecast.riskFids = next;
}

/* Panel ---------------------------------------------------------------------- */

function forecastRiskChip(risk) {
    return h("span", { className: `forecast-risk risk-${risk}` }, RISK[risk].label);
}

function forecastRunOutText(row) {
    if (row.risk === "out") return "Out now";
    if (row.runOut == null) return `> ${FORECAST_LOOKAHEAD} days`;
    return `${row.runOut === 1 ? "Tomorrow" : `in ${row.runOut} days`}`;
}

function forecastWeeklyChart(weekly) {
    const max = Math.max(...weekly, 1);
    const end = forecast.data.history_end;
    return h("div", { className: "forecast-weekly", role: "img", "aria-label": `Units sold per week, last ${weekly.length} weeks: ${weekly.join(", ")}` },
        ...weekly.map((value, i) => {
            const weekEnd = forecastAddDays(end, -7 * (weekly.length - 1 - i));
            return h("span", { className: "forecast-week", title: `Week to ${fcDate.format(weekEnd)}: ${value} units`, style: { height: `${Math.max(2, value / max * 100)}%` } });
        }));
}

function renderForecastDetails() {
    const panel = fc$("forecast-details");
    const row = forecast.rows.find((r) => r.sku === forecast.selectedSku);
    if (!row) { panel.replaceChildren(); panel.hidden = true; return; }
    panel.hidden = false;
    const outlooks = FORECAST_HORIZONS.map((days) => [days, forecastOutlook(row.entry, row.stock, days)]);
    const runOutDate = row.runOut ? fcDate.format(forecastAddDays(forecast.data.history_end, row.runOut)) : null;
    setChildren(panel,
        h("div", { className: "forecast-detail-head" },
            h("div", {}, h("div", { className: "forecast-detail-name" }, row.product.product_name),
                h("div", { className: "forecast-muted" }, `${row.sku} · ${row.rack.rack_id} · ${rackPlace(row.rack)}`)),
            forecastRiskChip(row.risk)),
        h("div", { className: "forecast-detail-grid" },
            h("div", {}, h("span", {}, "Stock now"), h("strong", {}, fcNumber.format(row.stock))),
            h("div", {}, h("span", {}, "Runs out"), h("strong", {}, row.risk === "out" ? "Out now" : runOutDate ? `${runOutDate} (${forecastRunOutText(row)})` : forecastRunOutText(row))),
            ...outlooks.map(([days, o]) => h("div", {}, h("span", {}, `Demand · ${days} days`),
                h("strong", {}, fcNumber.format(Math.round(o.demand))), h("small", {}, row.stock > 0 ? `${Math.round(o.chance * 100)}% chance to run out` : "")))),
        h("div", { className: "forecast-weekly-title" }, `Units sold per week · last ${row.entry[5].length} weeks`),
        forecastWeeklyChart(row.entry[5]),
        h("button", { type: "button", className: "inventory-link-button", onClick: () => selectRack(row.rack.rack_id, { zoom: true }) }, `Show ${row.rack.rack_id} on the map`));
}

function renderForecastStats() {
    const counts = { out: 0, high: 0, medium: 0 };
    let shortfall = 0;
    for (const row of forecast.rows) {
        if (counts[row.risk] != null) counts[row.risk] += 1;
        if (row.risk === "high" || row.risk === "medium") shortfall += row.shortfall;
    }
    const tile = (label, value, risk, caption) => h("div", { className: `forecast-stat risk-border-${risk}` },
        h("strong", {}, fcNumber.format(value)), h("span", {}, label), caption ? h("small", {}, caption) : null);
    fc$("forecast-stats").replaceChildren(
        tile("Likely to run out", counts.high, "high", `≥ 70% chance in ${forecast.horizon} days`),
        tile("At risk", counts.medium, "medium", "30–70% chance"),
        tile("Out of stock now", counts.out, "out", null),
        tile("Units short", Math.round(shortfall), "low", `expected, next ${forecast.horizon} days`));
}

function filteredForecastRows() {
    const { query, department, risk } = forecast.filters;
    const text = query.trim().toLowerCase();
    return forecast.rows.filter((row) => {
        if (risk === "atrisk" && row.risk !== "high" && row.risk !== "medium") return false;
        if (risk === "high" && row.risk !== "high") return false;
        if (risk === "out" && row.risk !== "out") return false;
        if (department && row.rack.department !== department) return false;
        if (text && ![row.sku, row.product.product_name, row.rack.rack_id].join(" ").toLowerCase().includes(text)) return false;
        return true;
    }).sort((a, b) => (a.runOut ?? 999) - (b.runOut ?? 999) || b.chance - a.chance || a.sku.localeCompare(b.sku));
}

function renderForecastList() {
    const rows = filteredForecastRows();
    fc$("forecast-count").textContent = `${fcNumber.format(rows.length)} SKUs`;
    fc$("forecast-demand-head").textContent = `Demand ${forecast.horizon} d`;
    const body = fc$("forecast-table-body");
    if (!rows.length) {
        body.replaceChildren(h("tr", {}, h("td", { colspan: "4", className: "empty" }, "No SKUs match - nothing expected to run out with these filters.")));
    } else {
        body.replaceChildren(...rows.slice(0, forecast.limit).map((row) => h("tr", {
            className: `risk-row-${row.risk}${row.sku === forecast.selectedSku ? " selected" : ""}`, tabindex: "0",
            onClick: () => selectForecastSku(row.sku),
            onKeydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectForecastSku(row.sku); } },
        },
            h("td", { className: "forecast-product" }, h("span", { title: row.product.product_name }, row.product.product_name),
                h("small", {}, `${row.sku} · ${row.rack.rack_id}`)),
            h("td", { className: "num" }, fcNumber.format(row.stock)),
            h("td", { className: "num" }, fcNumber.format(Math.round(row.demand))),
            h("td", { className: "forecast-runout" }, forecastRiskChip(row.risk), h("small", {}, row.risk === "out" ? "" : forecastRunOutText(row))))));
    }
    const more = fc$("forecast-more");
    more.hidden = rows.length <= forecast.limit;
    more.textContent = `Show more (${fcNumber.format(rows.length - forecast.limit)} left)`;
}

function renderForecastDepartments() {
    const select = fc$("forecast-department");
    const departments = [...new Set(forecast.rows.map((row) => row.rack.department))].sort();
    select.replaceChildren(new Option("All departments", ""), ...departments.map((d) => new Option(d, d)));
    select.value = departments.includes(forecast.filters.department) ? forecast.filters.department : "";
    forecast.filters.department = select.value;
}

function renderForecastPanel() {
    const message = fc$("forecast-message");
    const content = fc$("forecast-content");
    for (const button of document.querySelectorAll("#forecast-horizon button")) button.setAttribute("aria-pressed", String(Number(button.dataset.days) === forecast.horizon));
    const text = !state.currentStoreId ? "Select a store to see its demand forecast."
        : forecast.loading ? "Loading demand forecast…"
        : forecast.error || (!forecast.data ? "No demand forecast for this store." : "");
    message.textContent = text;
    message.hidden = !text;
    content.hidden = Boolean(text);
    if (text) return;
    const backtest = forecast.data.model?.backtest;
    fc$("forecast-model").textContent = `Based on ${forecast.data.history_days} days of simulated sales to ${fcDate.format(forecastAddDays(forecast.data.history_end, 0))} `
        + `(weekly pattern, recent sales, trend)${backtest ? ` · tested error on the last ${backtest.horizon_days} days: ${Math.round(backtest.wape * 100)}%` : ""}. Uses current stock, including picks.`;
    renderForecastStats();
    renderForecastList();
    renderForecastDetails();
}

function refreshForecast() {
    if (!forecastActive()) { renderForecastMap(); return; }
    forecast.rows = computeForecastRows();
    renderForecastPanel();
    renderForecastMap();
}

function selectForecastSku(sku) {
    forecast.selectedSku = forecast.selectedSku === sku ? null : sku;
    const row = forecast.rows.find((r) => r.sku === forecast.selectedSku);
    if (row) selectRack(row.rack.rack_id, { zoom: true });
    renderForecastList();
    renderForecastDetails();
}

/* Loading & hooks -------------------------------------------------------------- */

async function loadForecast() {
    const storeId = state.currentStoreId;
    if (!storeId || (forecast.storeId === storeId && (forecast.data || forecast.loading))) return;
    const generation = ++forecast.generation;
    Object.assign(forecast, { storeId, data: null, loading: true, error: "", selectedSku: null, rows: [], limit: FORECAST_PAGE });
    renderForecastPanel();
    try {
        const response = await fetch(`data/forecast/${encodeURIComponent(storeId)}.json`, { cache: "no-cache" });
        if (generation !== forecast.generation) return;
        if (response.status === 404) forecast.data = null;
        else if (!response.ok) throw new Error(`HTTP ${response.status}`);
        else forecast.data = await response.json();
    } catch (error) {
        console.error(`Forecast ${storeId}:`, error);
        if (generation === forecast.generation) forecast.error = "The demand forecast could not be loaded.";
    }
    if (generation !== forecast.generation) return;
    forecast.loading = false;
    forecast.rows = computeForecastRows();
    renderForecastDepartments();
    refreshForecast();
}

function subscribeForecastInventory() {
    forecast.unsubscribe?.();
    forecast.unsubscribe = inventory.model?.subscribe?.(() => { if (forecastActive()) refreshForecast(); }) || null;
}

// Called by the store map once a store's inventory is ready (inventory.js).
function onForecastStoreReady() {
    if (forecast.storeId !== state.currentStoreId) {
        ++forecast.generation;
        Object.assign(forecast, { storeId: null, data: null, loading: false, error: "", rows: [], selectedSku: null });
    }
    subscribeForecastInventory();
    if (forecastActive()) loadForecast(); else renderForecastMap();
}

// Called when the panel's tab changes (picking-workflow.js).
function onOpsTabChanged(tab) {
    if (tab === "forecast") {
        if (forecast.storeId === state.currentStoreId && forecast.data) refreshForecast();
        else loadForecast();
    } else {
        renderForecastMap();
    }
}

function wireForecastPanel() {
    for (const button of document.querySelectorAll("#forecast-horizon button")) {
        button.addEventListener("click", () => { forecast.horizon = Number(button.dataset.days); forecast.limit = FORECAST_PAGE; refreshForecast(); });
    }
    fc$("forecast-search").addEventListener("input", (event) => { forecast.filters.query = event.target.value; forecast.limit = FORECAST_PAGE; renderForecastList(); });
    fc$("forecast-department").addEventListener("change", (event) => { forecast.filters.department = event.target.value; forecast.limit = FORECAST_PAGE; renderForecastList(); });
    fc$("forecast-risk-filter").addEventListener("change", (event) => { forecast.filters.risk = event.target.value; forecast.limit = FORECAST_PAGE; renderForecastList(); });
    fc$("forecast-more").addEventListener("click", () => { forecast.limit += FORECAST_PAGE; renderForecastList(); });
}

document.addEventListener("DOMContentLoaded", wireForecastPanel);

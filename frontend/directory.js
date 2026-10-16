/* Nationwide directory. Reuses the existing MapLibre layers, labels and controls. */
const directory = {
    cache: new Map(),
    generation: 0,
    limit: 100,
    bounds: null,
    extras: new MarkerGroup(),
    extrasVisible: true,
    location: null,
    sourceData: null,
};
const el = id => document.getElementById(id);
const defaultDebug = () => ({
    offset_x: 0,
    offset_y: 0,
    scale: 1,
    rotation: 0,
    corners: {
        nw: { x: 0, y: 0 },
        ne: { x: 0, y: 0 },
        sw: { x: 0, y: 0 },
        se: { x: 0, y: 0 },
    },
});

function collectLayers(value, path = '', out = []) {
    if (!value || typeof value !== 'object') return out;
    if (value.type === 'FeatureCollection') out.push([path, value]);
    else Object.entries(value).forEach(([key, child]) => collectLayers(child, `${path}/${key}`, out));
    return out;
}

function groupLayers(value) {
    const grouped = Object.fromEntries(FLOORPLAN_LAYER_KEYS.map(key => [key, emptyCollection()]));
    const extra = emptyCollection();
    const layers = collectLayers(value);
    if (!layers.length) throw new Error('Malformed map: no FeatureCollections');
    for (const [name, fc] of layers) {
        if (!Array.isArray(fc.features)) throw new Error('Malformed map features');
        for (const feature of fc.features) {
            if (feature.type !== 'Feature') throw new Error('Malformed GeoJSON feature');
            if (!feature.geometry || feature.geometry.coordinates?.length === 0) continue;
            const type = feature.geometry.type;
            const category = `${name} ${feature.properties?.kind || ''}`.toLowerCase();
            const family = /department|depertment/.test(category) ? 'department' : /aisle/.test(category) ? 'aisle' : /rack/.test(category) ? 'rack' : null;
            const suffix = /Point$/.test(type) ? 'Points' : /LineString$/.test(type) ? 'Lines' : 's';
            const key = family ? family + suffix : '';
            // Labels and popups are rendered with textContent, so property text never becomes HTML.
            if (grouped[key] && type !== 'MultiPoint') grouped[key].features.push(feature);
            else extra.features.push(feature);
        }
    }
    return { grouped, extra };
}

function coordinatePoints(value) {
    const points = [];
    const walk = node => {
        if (!Array.isArray(node)) return;
        if (node.length >= 2 && node.every((item, index) => index > 1 || typeof item === 'number')) { points.push(node); return; }
        node.forEach(walk);
    };
    collectLayers(value).forEach(([, fc]) => fc.features.forEach(feature => walk(feature.geometry?.coordinates)));
    return points;
}

function mapCoordinates(value, mapper) {
    const copy = JSON.parse(JSON.stringify(value));
    const walk = node => {
        if (!Array.isArray(node)) return;
        if (node.length >= 2 && node.every((item, index) => index > 1 || typeof item === 'number')) {
            const [lon, lat] = mapper(node[0], node[1]);
            node[0] = lon;
            node[1] = lat;
            return;
        }
        node.forEach(walk);
    };
    collectLayers(copy).forEach(([, fc]) => fc.features.forEach(feature => walk(feature.geometry?.coordinates)));
    return copy;
}

function sourceBounds(value) {
    const points = coordinatePoints(value);
    if (!points.length) return null;
    const minX = Math.min(...points.map(point => point[0]));
    const maxX = Math.max(...points.map(point => point[0]));
    const minY = Math.min(...points.map(point => point[1]));
    const maxY = Math.max(...points.map(point => point[1]));
    return {
        minX, maxX, minY, maxY,
        width: maxX - minX || 1,
        height: maxY - minY || 1,
        corners: {
            nw: [minX, minY],
            ne: [maxX, minY],
            sw: [minX, maxY],
            se: [maxX, maxY],
        },
    };
}

function normalizedDebug(debug) {
    const base = defaultDebug();
    return {
        ...base,
        ...(debug || {}),
        corners: {
            ...base.corners,
            ...((debug || {}).corners || {}),
        },
    };
}

function debugContext(value, store) {
    const debug = store.debugGeoreference;
    if (!debug || !Number.isFinite(store.latitude) || !Number.isFinite(store.longitude)) return null;
    const bounds = sourceBounds(value);
    if (!bounds) return null;
    const sourceLon = (bounds.minX + bounds.maxX) / 2;
    const sourceLat = (bounds.minY + bounds.maxY) / 2;
    const metersPerLat = 111320;
    const metersPerLon = Math.max(1, metersPerLat * Math.cos(store.latitude * Math.PI / 180));
    const targetLon = store.longitude + (Number(debug.offset_x) || 0) / metersPerLon;
    const targetLat = store.latitude + (Number(debug.offset_y) || 0) / metersPerLat;
    const scale = Number(debug.scale) || 1;
    const angle = (Number(debug.rotation) || 0) * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return { bounds, sourceLon, sourceLat, metersPerLat, metersPerLon, targetLon, targetLat, scale, cos, sin, debug: normalizedDebug(debug) };
}

function projectSourcePoint(lon, lat, context, includeCornerWarp = true) {
    const sourceX = (lon - context.sourceLon) * context.metersPerLon;
    const sourceY = (lat - context.sourceLat) * context.metersPerLat;
    let x = (sourceX * context.cos - sourceY * context.sin) * context.scale;
    let y = (sourceX * context.sin + sourceY * context.cos) * context.scale;
    if (includeCornerWarp) {
        const { bounds, debug } = context;
        const corners = debug.corners;
        const u = Math.min(1, Math.max(0, (lon - bounds.minX) / bounds.width));
        const v = Math.min(1, Math.max(0, (lat - bounds.minY) / bounds.height));
        const topX = corners.nw.x * (1 - u) + corners.ne.x * u;
        const bottomX = corners.sw.x * (1 - u) + corners.se.x * u;
        const topY = corners.nw.y * (1 - u) + corners.ne.y * u;
        const bottomY = corners.sw.y * (1 - u) + corners.se.y * u;
        x += topX * (1 - v) + bottomX * v;
        y += topY * (1 - v) + bottomY * v;
    }
    return [context.targetLon + x / context.metersPerLon, context.targetLat + y / context.metersPerLat];
}

function applyDebugGeoreference(value, store) {
    const context = debugContext(value, store);
    if (!context) return null;
    return mapCoordinates(value, (lon, lat) => projectSourcePoint(lon, lat, context));
}

function alignSourceMap(value, store) {
    const debugAligned = applyDebugGeoreference(value, store);
    if (debugAligned) return debugAligned;
    if (!Number.isFinite(store.latitude) || !Number.isFinite(store.longitude)) return value;
    const layers = collectLayers(value);
    if (!layers.length || layers.some(([, fc]) => fc.metadata?.source_type)) return value;
    const points = coordinatePoints(value);
    if (!points.length) return value;
    const minX = Math.min(...points.map(point => point[0]));
    const maxX = Math.max(...points.map(point => point[0]));
    const minY = Math.min(...points.map(point => point[1]));
    const maxY = Math.max(...points.map(point => point[1]));
    const dx = store.longitude - (minX + maxX) / 2;
    const dy = store.latitude - (minY + maxY) / 2;
    return mapCoordinates(value, (lon, lat) => [lon + dx, lat + dy]);
}

async function browserStoreDetails(store) {
    if (!store.store_url) throw new Error('Store URL unavailable');
    const response = await fetch(store.store_url);
    if (!response.ok) throw new Error(`${response.status} store page`);
    const html = await response.text();
    const get = pattern => html.match(pattern)?.[1] || '';
    const details = {
        store_id: store.store_id,
        name: get(/"storeName"\s*:\s*"([^"]+)"/) || store.name,
        address: get(/"address"\s*:\s*"([^"]+)"/),
        city: get(/"city"\s*:\s*"([^"]+)"/) || store.city,
        state: 'Connecticut', state_code: 'CT',
        zip: get(/"zip"\s*:\s*"([0-9]{5}(?:-[0-9]{4})?)"/),
        latitude: Number(get(/"lat"\s*:\s*"(-?[0-9]+\.[0-9]+)"/)),
        longitude: Number(get(/"long"\s*:\s*"(-?[0-9]+\.[0-9]+)"/)),
        store_url: store.store_url,
        map_url: store.map_url || `https://www.lowes.com/omniselling/store/${store.store_id}/map-view`,
    };
    details.address = [details.address, details.city, details.state, details.zip].filter(Boolean).join(', ');
    await fetchJSON(`/api/catalog/stores/${encodeURIComponent(store.store_id)}/details`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details) });
    return details;
}

// Checkbox for features outside the known layers, like Leaflet's layers control.
class ExtrasControl {
    onAdd() {
        this.container = document.createElement('div');
        this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group extras-control';
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = directory.extrasVisible;
        checkbox.addEventListener('change', () => { directory.extrasVisible = checkbox.checked; updateExtrasVisibility(); });
        label.append(checkbox, ' Additional map features');
        this.container.append(label);
        return this.container;
    }

    onRemove() {
        this.container.remove();
    }
}

function updateExtrasVisibility() {
    if (!state.map) return;
    for (const id of ['extras-fill', 'extras-line', 'extras-circle']) {
        if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', directory.extrasVisible ? 'visible' : 'none');
    }
    directory.extras.setVisible(directory.extrasVisible);
}

function clearExtras() {
    state.map.getSource('extras')?.setData(emptyCollection());
    directory.extras.clearLayers();
    directory.extrasVisible = true;
    if (directory.control) { state.map.removeControl(directory.control); directory.control = null; }
}

function options(id, values, selected = '') {
    const select = el(id);
    const first = select.options[0].text;
    select.replaceChildren(new Option(first, ''));
    [...new Set(values.filter(Boolean))].sort().forEach(v => select.add(new Option(v, v)));
    select.value = selected;
}

function matchingStores() {
    const query = el('store-search').value.toLowerCase().trim();
    return state.stores.filter(s => (!el('state-filter').value || (s.state_code || s.state) === el('state-filter').value)
        && (!el('city-filter').value || s.city === el('city-filter').value)
        && [s.name, s.store_id, s.city, s.state, s.zip, s.address].join(' ').toLowerCase().includes(query));
}

function renderDirectory() {
    const stores = matchingStores();
    el('result-count').textContent = `${stores.length.toLocaleString()} stores`;
    const fragment = document.createDocumentFragment();
    for (const s of stores.slice(0, directory.limit)) {
        const button = document.createElement('button');
        button.className = 'store-result';
        button.dataset.storeId = s.store_id;
        button.setAttribute('aria-pressed', String(s.store_id === state.currentStoreId));
        const title = document.createElement('strong'); title.textContent = s.name;
        const subtitle = document.createElement('span'); subtitle.textContent = `${s.city || ''}, ${s.state || ''} · #${s.store_id}`;
        const status = document.createElement('small'); status.textContent = (s.map_file || s.indoor_map_status === 'success') ? 'Indoor map available' : s.indoor_map_status === 'failed' ? 'Indoor map failed' : s.indoor_map_status === 'no_indoor_map' ? 'Indoor map unavailable' : (s.state_code === 'CT' || s.state === 'CT') ? 'Checking indoor map' : 'Indoor map pending';
        button.append(title, subtitle, status);
        button.addEventListener('click', () => loadStore(s.store_id));
        fragment.append(button);
    }
    el('store-list').replaceChildren(fragment);
    el('more-stores').hidden = stores.length <= directory.limit;
}

async function loadDebugGeoreference(store) {
    store.debugGeoreference = await fetchJSON(`/api/store/${encodeURIComponent(store.store_id)}/debug-georeference`, { cache: 'no-store' });
    return store.debugGeoreference;
}

function renderAlignedMap(store, sourceData, fitViewport = true) {
    clearFeatureLayers(); clearExtras();
    const data = alignSourceMap(sourceData, store);
    const { grouped, extra } = groupLayers(data);
    store.indoor_map_status = 'success';
    renderDirectory();
    renderGeoJsonFloorplanData(grouped);
    if (extra.features.length) {
        const shapes = emptyCollection();
        for (const feature of extra.features) {
            if (feature.geometry.type !== 'Point') { shapes.features.push(feature); continue; }
            const marker = buildGeoJsonPointLayer(feature).layer;
            if (marker.getPopup()) {
                const text = document.createElement('span');
                text.textContent = feature.properties?.name || feature.properties?.label || feature.properties?.poi_name || 'Map feature';
                marker.setPopup(new maplibregl.Popup().setDOMContent(text));
            }
            directory.extras.addLayer(marker);
        }
        state.map.getSource('extras').setData(shapes);
        directory.control = new ExtrasControl();
        state.map.addControl(directory.control, 'bottom-right');
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const key of ['departments', 'aisles', 'racks', 'departmentLines', 'aisleLines', 'rackLines']) featuresBounds(grouped[key].features, bounds);
    featuresBounds(extra.features, bounds);
    state.layers.markerGroup.getLayers().forEach(marker => bounds.extend(marker.getLngLat()));
    const valid = boundsAreValid(bounds);
    directory.bounds = valid ? bounds : null;
    el('view-indoor').hidden = !valid;
    const mismatch = valid && directory.location && bounds.getCenter().distanceTo(directory.location) > 2000;
    if (fitViewport && valid && !mismatch) {
        fitMapBounds(padBounds(bounds, 0.12), ZOOM.DEPT_LABELS);
        console.info(`[MAP] fitBounds executed for ${store.store_id}`);
    }
    el('map-status').textContent = mismatch ? 'Indoor data uses different source coordinates. Select Indoor map to view it separately.' :
        store.map_status === 'failed' ? 'Saved map shown; latest refresh failed.' : 'Indoor map ready';
    updateZoomVisibility();
    if (typeof onInventoryMapRendered === 'function') onInventoryMapRendered(store, data, sourceData);
}

async function loadStores() {
    let states = null;
    try { states = await fetchJSON('/api/states'); } catch (error) { console.warn('Directory states unavailable:', error); }
    let response;
    try {
        response = await fetchJSON('/api/stores');
        state.stores = Array.isArray(response) ? response : response.stores;
    } catch (error) {
        response = await fetchJSON('/api/catalog/stores');
        state.stores = response.stores;
    }
    const stateSelect = el('state-filter');
    if (Array.isArray(states) && states.length) {
        stateSelect.replaceChildren(new Option('All states', ''));
        states.forEach(item => stateSelect.add(new Option(item.state_name || item.name, item.state_code || item.state)));
    } else {
        stateSelect.replaceChildren(new Option('All states', ''));
        [...new Map(state.stores.map(s => [s.state_code || s.state, s.state || s.state_code])).entries()]
            .sort((a, b) => a[1].localeCompare(b[1])).forEach(([code, name]) => stateSelect.add(new Option(name, code)));
    }
    stateSelect.value = '';
    // A state filter is pointless while every store is in one state.
    const singleState = stateSelect.options.length <= 2;
    stateSelect.hidden = singleState;
    document.querySelector('label[for="state-filter"]').hidden = singleState;
    options('city-filter', state.stores.map(s => s.city));
    const citySelect = el('city-filter');
    if (citySelect) citySelect.value = '';
    el('store-search').addEventListener('input', () => { directory.limit = 100; renderDirectory(); });
    el('state-filter').addEventListener('change', async () => {
        const code = el('state-filter').value;
        if (code) {
            directory.limit = 100; renderDirectory();
            try { options('city-filter', await fetchJSON(`/api/cities?state=${encodeURIComponent(code)}`)); }
            catch (error) { options('city-filter', state.stores.filter(s => (s.state_code || s.state) === code).map(s => s.city)); }
            try {
                const stores = await fetchJSON(`/api/stores?state=${encodeURIComponent(code)}`);
                if (Array.isArray(stores)) state.stores = stores;
            } catch (error) { console.warn('State stores unavailable:', error); }
        } else options('city-filter', state.stores.map(s => s.city));
        directory.limit = 100; renderDirectory();
    });
    el('city-filter').addEventListener('change', () => { directory.limit = 100; renderDirectory(); });
    el('more-stores').addEventListener('click', () => { directory.limit += 100; renderDirectory(); });
    el('view-location').onclick = () => directory.location && state.map.easeTo({ center: directory.location, zoom: ZOOM.STORE_LEVEL });
    el('view-indoor').onclick = () => directory.bounds && fitMapBounds(padBounds(directory.bounds, 0.12), ZOOM.DEPT_LABELS_ALL, true);
    renderDirectory();
    try {
        const report = await fetchJSON('/api/catalog/report');
        el('catalog-status').textContent = report.discovery_error ? 'Nationwide discovery is incomplete. Showing saved stores.' : response.message || '';
    } catch (error) { console.warn(error); }
    // ?store=<id> (e.g. from Store comparison) opens that store; otherwise the first one.
    const wanted = new URLSearchParams(window.location.search).get('store');
    const first = state.stores.find(s => s.store_id === wanted) || state.stores[0];
    if (first) await loadStore(first.store_id);
};

function showStorePin(store) {
    directory.location = new maplibregl.LngLat(store.longitude, store.latitude);
    state.map.jumpTo({ center: directory.location, zoom: DEFAULT_ZOOM });
    const popup = document.createElement('div'); popup.textContent = `${store.name} — ${store.address}`;
    state.layers.storePin = new maplibregl.Marker().setLngLat(directory.location).setPopup(new maplibregl.Popup().setDOMContent(popup)).addTo(state.map);
}

async function loadStore(storeId) {
    const generation = ++directory.generation;
    const store = state.stores.find(s => s.store_id === storeId);
    if (!store) return;
    state.currentStoreId = storeId; state.currentStore = store;
    clearFeatureLayers(); clearExtras();
    if (state.layers.storePin) { state.layers.storePin.remove(); state.layers.storePin = null; }
    directory.bounds = null; directory.location = null;
    directory.sourceData = null;
    el('view-indoor').hidden = true; el('view-location').hidden = true;
    el('selected-name').textContent = `${store.name} · #${store.store_id}`;
    el('selected-address').textContent = store.address || 'Address unavailable';
    el('map-status').textContent = 'Loading store map…';
    renderDirectory();
    if (store.state_code === 'CT' || store.state === 'CT') {
        try {
            const details = await fetchJSON(`/api/catalog/stores/${encodeURIComponent(storeId)}/details`);
            Object.assign(store, details);
            el('selected-name').textContent = `${store.name} · #${store.store_id}`;
            el('selected-address').textContent = store.address || 'Address unavailable';
        } catch (error) {
            try { Object.assign(store, await browserStoreDetails(store)); }
            catch (browserError) { console.warn(`Store details ${storeId}:`, browserError); }
            el('selected-address').textContent = store.address || 'Address unavailable';
        }
    }
    if (generation !== directory.generation) return;
    if (store.state_code !== 'CT' && store.state !== 'CT' && !store.map_file && store.indoor_map_status !== 'success') {
        if (Number.isFinite(store.latitude) && Number.isFinite(store.longitude)) {
            showStorePin(store);
            el('view-location').hidden = false;
        }
        el('map-status').textContent = 'Indoor map unavailable';
        return;
    }
    try {
        await loadDebugGeoreference(store);
    } catch (error) {
        if (generation !== directory.generation) return;
        el('map-status').textContent = 'Saved alignment could not be loaded. Reload to retry.';
        return;
    }
    if (generation !== directory.generation) return;
    if (Number.isFinite(store.latitude) && Number.isFinite(store.longitude)) {
        showStorePin(store);
        el('view-location').hidden = false;
    } else {
        state.map.jumpTo({ center: DEFAULT_CENTER, zoom: OVERVIEW_ZOOM });
    }
    try {
        if (store.state_code !== 'CT' && store.state !== 'CT' && !store.map_file && store.indoor_map_status !== 'success') { el('map-status').textContent = 'Indoor map unavailable'; return; }
        let data = directory.cache.get(storeId);
        if (!data) {
            try {
                data = await fetchJSON(`/api/catalog/stores/${encodeURIComponent(storeId)}/map`);
            } catch (error) {
                if (store.state_code === 'CT' || store.state === 'CT') {
                    const source = `https://www.lowes.com/omniselling/store/${encodeURIComponent(storeId)}/map-view`;
                    try { data = await fetchJSON(source); }
                    catch (sourceError) { if (sourceError.message.startsWith('404')) throw new Error('Indoor map unavailable'); throw sourceError; }
                    await fetchJSON(`/api/catalog/stores/${encodeURIComponent(storeId)}/map`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
                    console.info(`[MAP] requested URL: ${source}`);
                    console.info(`[MAP] JSON keys: ${Object.keys(data).join(', ')}`);
                } else data = await fetchJSON(`/api/stores/${encodeURIComponent(storeId)}/map`);
            }
            directory.cache.set(storeId, data);
            if (directory.cache.size > 5) directory.cache.delete(directory.cache.keys().next().value);
        }
        if (generation !== directory.generation) return;
        directory.sourceData = data;
        renderAlignedMap(store, data);
        console.info(`[MAP] MapLibre layers added for ${storeId}`);
    } catch (error) {
        if (generation !== directory.generation) return;
        clearFeatureLayers(); clearExtras();
        const unavailable = error.message.includes('Indoor map unavailable');
        store.indoor_map_status = unavailable ? 'no_indoor_map' : 'failed';
        renderDirectory();
        el('map-status').textContent = unavailable ? 'Indoor map unavailable' : 'Indoor map failed';
        console.error(`Map ${storeId}:`, error);
    }
};

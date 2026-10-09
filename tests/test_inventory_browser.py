"""Browser checks for the simulated rack inventory dashboard on real store data."""
import asyncio
import json
import mimetypes
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from generate_inventory import MIN_RACK_AREA, StoreGeometry  # noqa: E402
STORE_IDS = ('1665', '2544')


def _store_entry(store_id):
    store = json.loads((ROOT / 'stores' / store_id / 'store.json').read_text(encoding='utf-8'))
    return {**store, 'store_id': store_id, 'state': 'Connecticut', 'state_code': 'CT', 'map_file': 'saved', 'indoor_map_status': 'success'}


def _store_map(store_id):
    # Same shape as backend/catalog_api.py store_map().
    files = {'Lowes_aisle': 'aisle', 'Lowes_depertment': 'department', 'Lowes_rack': 'rack'}
    return {key: json.loads((ROOT / 'stores' / store_id / f'{name}.geojson').read_text(encoding='utf-8')) for key, name in files.items()}


def test_inventory_dashboard_links_racks_edits_and_persists():
    stores = [_store_entry(store_id) for store_id in STORE_IDS]
    # Every bay above the sliver threshold must carry inventory.
    expected = {store_id: sum(r['poly'].area >= MIN_RACK_AREA for r in StoreGeometry(ROOT / 'stores' / store_id).racks) for store_id in STORE_IDS}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def send(self, status, payload, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path.endswith('/debug-georeference'):
                return self.send(200, b'{}')
            if path == '/api/catalog/stores':
                return self.send(200, json.dumps({'stores': stores}).encode())
            if path == '/api/catalog/report':
                return self.send(200, b'{}')
            for store_id in STORE_IDS:
                if path == f'/api/catalog/stores/{store_id}/map':
                    return self.send(200, json.dumps(_store_map(store_id)).encode())
                if path == f'/api/catalog/stores/{store_id}/details':
                    return self.send(200, json.dumps(_store_entry(store_id)).encode())
            file = (ROOT / 'frontend' / path.lstrip('/')).resolve() if path != '/' else ROOT / 'frontend/index.html'
            if ROOT / 'frontend' in file.parents and file.is_file():
                return self.send(200, file.read_bytes(), mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
            self.send(404, b'{"error":"not found"}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}/'
    ready = "inventory.model && inventory.storeId === '1665' && inventory.racks.size > 0"

    async def verify():
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            page = await browser.new_page(viewport={'width': 1600, 'height': 960})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('dialog', lambda dialog: asyncio.ensure_future(dialog.accept()))
            await page.route('https://**/*', lambda route: route.abort())
            await page.goto(url)
            await page.wait_for_function(ready)

            # 1. Every rack bay is linked, once, to existing Lowes_rack geometry.
            linked = await page.evaluate("""() => ({
                size: inventory.racks.size, unlinked: inventory.unlinked.length,
                ids: [...inventory.racks.keys()], fids: new Set([...inventory.racks.values()].map(r => r.fid)).size,
                refs: new Set(inventory.model.list().map(r => r.geometry_ref.feature + ':' + r.geometry_ref.part)).size })""")
            total = expected['1665']
            assert linked['size'] == total and linked['unlinked'] == 0 and linked['fids'] == total and linked['refs'] == total
            assert sorted(linked['ids']) == [f'R-{i:04d}' for i in range(1, total + 1)]
            # Pick test racks from the data: one with aisle, department and several products, one other occupied rack.
            sample = await page.evaluate("""() => {
                const racks = inventory.model.list();
                const full = racks.filter(r => r.aisle_id && r.department !== 'Unassigned' && r.products.length > 1 && r.occupancy_band !== 'vacant');
                return { a: full[0].rack_id, b: full[Math.floor(full.length / 2)].rack_id, c: full[full.length - 1].rack_id };
            }""")
            A, B, C = sample['a'], sample['b'], sample['c']

            # 2. Racks with a department lie inside that store's department floor area.
            outside = await page.evaluate("""() => {
                const parts = state.layers.data.departments.features.flatMap(f =>
                    f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]);
                const inRing = ([x, y], ring) => { let hit = false;
                    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                        const [xi, yi] = ring[i], [xj, yj] = ring[j];
                        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit; }
                    return hit; };
                return [...inventory.racks].filter(([id, r]) => inventory.model.get(id).department !== 'Unassigned'
                    && !parts.some(p => inRing(r.center, p[0]))).map(([id]) => id);
            }""")
            assert outside == []

            # 5. Map colours follow each record's occupancy band.
            mismatched = await page.evaluate("""() => {
                const features = state.map.getSource('inventory-racks')._data.features;
                return features.filter(f => inventory.model.get(f.properties.rack_id).occupancy_band !== f.properties.band).length
                    + (features.length === inventory.racks.size ? 0 : 100000);
            }""")
            assert mismatched == 0
            bands = await page.evaluate("inventory.model.list().map(r => [r.occupancy_band, r.occupancy_percentage])")
            for band, pct in bands:
                assert band == ('vacant' if pct == 0 else 'high' if pct > 70 else 'partial' if pct >= 30 else 'low')

            # 4. Search by rack ID, product, aisle and department.
            async def search(text):
                await page.locator('#inventory-search').fill(text)
                return await page.locator('.inventory-result').evaluate_all('nodes => nodes.map(n => n.dataset.rackId)')
            assert (await search(C))[0] == C
            product = await page.evaluate(f"inventory.model.get('{A}').products[1]")
            assert (await search(product['sku'])) == [A]
            assert len(await search(product['product_name'])) > 0
            aisle = await page.evaluate(f"inventory.model.get('{B}').aisle_id")
            aisle_hits = await search(f'aisle {aisle}')
            assert aisle_hits
            hit_aisles = await page.evaluate("ids => ids.map(id => inventory.model.get(id).aisle_id)", aisle_hits)
            assert set(hit_aisles) == {aisle}
            dept = await page.evaluate(f"inventory.model.get('{B}').department")
            dept_hits = await search(dept)
            assert dept_hits and all(d == dept for d in await page.evaluate("ids => ids.map(id => inventory.model.get(id).department)", dept_hits))

            # Selecting a result zooms to the rack and opens its details.
            await search(B)
            await page.locator('.inventory-result').first.click()
            await page.wait_for_timeout(1200)
            assert await page.locator('#inventory-details-title').inner_text() == B
            center = await page.evaluate("state.map.getCenter().toArray()")
            rack_center = await page.evaluate(f"inventory.racks.get('{B}').center")
            assert abs(center[0] - rack_center[0]) < 0.0003 and abs(center[1] - rack_center[1]) < 0.0003

            # 3. Clicking a rack on the map opens that rack's details.
            await page.evaluate(f"window.RACK = '{A}'")
            await page.evaluate("state.map.jumpTo({ center: inventory.racks.get(RACK).center, zoom: 20 })")
            await page.wait_for_timeout(800)
            point = await page.evaluate("(() => { const p = state.map.project(inventory.racks.get(RACK).center); const r = state.map.getCanvas().getBoundingClientRect(); return [p.x + r.left, p.y + r.top]; })()")
            await page.mouse.click(*point)
            await page.wait_for_timeout(300)
            assert await page.locator('#inventory-details-title').inner_text() == A
            assert await page.locator('.maplibregl-popup:not(.inventory-hover)').count() == 0  # base rack popup suppressed
            assert await page.locator('.inventory-hover').count() == 1  # hover tooltip with occupancy

            # 9. Existing department / aisle labels remain on the map.
            assert await page.locator('.maplibregl-canvas-container .dept-label').count() > 0
            assert await page.locator('.maplibregl-canvas-container .aisle-label').count() > 0
            assert await page.locator('.inventory-rack-label').count() > 0

            # 6. Editing updates record, map colour and dashboard immediately.
            before = await page.evaluate("inventory.model.stats()")
            was_vacant = await page.evaluate("inventory.model.get(RACK).occupancy_band === 'vacant'")
            assert not was_vacant
            await page.locator('#inventory-mark-vacant').click()
            after = await page.evaluate("inventory.model.stats()")
            assert after['vacant'] == before['vacant'] + 1
            assert await page.evaluate("state.map.getSource('inventory-racks')._data.features.find(f => f.properties.rack_id === RACK).properties.band") == 'vacant'
            assert await page.locator('#inventory-details .inventory-chip').inner_text() == 'Vacant'
            await page.locator('#inventory-edit-quantity').fill('2')
            await page.locator('#inventory-add-stock').click()
            added = await page.evaluate("inventory.model.get(RACK)")
            assert added['stock_quantity'] == 2 and added['occupied_capacity'] > 0
            assert await page.locator('#inventory-edit-status').inner_text() != ''
            await page.locator('#inventory-edit-occupied').fill('0')
            await page.locator('#inventory-set-occupied').click()
            assert await page.evaluate("inventory.model.get(RACK).occupancy_band") == 'vacant'
            assert await page.evaluate("inventory.model.get(RACK).stock_quantity") == 2  # occupancy is separate from stock
            await page.locator('#inventory-edit-occupied').fill('9999')
            await page.locator('#inventory-set-occupied').click()
            assert 'whole number' in await page.locator('#inventory-edit-status').inner_text()

            # 7. Edits persist after a refresh; Reset All restores the default stock.
            await page.reload()
            await page.wait_for_function(ready)
            await page.evaluate(f"window.RACK = '{A}'")
            assert await page.evaluate("inventory.model.get(RACK).stock_quantity") == 2
            assert await page.evaluate("inventory.model.get(RACK).occupancy_band") == 'vacant'
            await page.locator('#inventory-reset-all').click()
            await page.wait_for_function("inventory.model.get(RACK).occupancy_band !== 'vacant'")
            assert await page.evaluate("Object.keys(inventory.model.overrides).length") == 0

            # Filters narrow both the list and the map highlights.
            await page.locator('#inventory-filter-band').select_option('high')
            listed = int((await page.locator('#inventory-list-count').inner_text()).split()[0].replace(',', ''))
            visible = await page.evaluate("state.map.getSource('inventory-racks')._data.features.filter(f => f.properties.visible).length")
            assert listed == visible == await page.evaluate("inventory.model.stats().occupied")
            assert await page.locator('#inventory-table-body tr').count() == min(100, listed)
            await page.locator('#inventory-clear-filters').click()
            assert await page.locator('#inventory-table-body tr').count() == 100
            await page.locator('#inventory-more').click()
            assert await page.locator('#inventory-table-body tr').count() == 200

            # 10. Visualisation off leaves the store's rack layers untouched.
            racks_before = await page.evaluate("JSON.stringify([state.layers.data.racks, state.map.getLayoutProperty('racks-fill', 'visibility')])")
            await page.locator('#layer-inventory').uncheck()
            assert await page.evaluate("state.map.getLayoutProperty('inventory-rack-fill', 'visibility')") == 'none'
            assert await page.locator('.inventory-rack-label').count() == 0
            assert await page.locator('.inventory-legend').is_hidden()
            assert await page.evaluate("JSON.stringify([state.layers.data.racks, state.map.getLayoutProperty('racks-fill', 'visibility')])") == racks_before
            await page.locator('#layer-inventory').check()
            assert await page.evaluate("state.map.getLayoutProperty('inventory-rack-fill', 'visibility')") == 'visible'

            # 8. Existing map controls still work.
            zoom = await page.evaluate("state.map.getZoom()")
            await page.locator('.maplibregl-ctrl-zoom-out').click()
            await page.wait_for_function(f"state.map.getZoom() < {zoom} && !state.map.isMoving()")
            await page.locator('#layer-department').uncheck()
            assert not await page.evaluate("isLayerVisible('departments')")
            await page.locator('#layer-department').check()
            await page.locator('#layer-satellite').uncheck()
            assert await page.evaluate("state.map.getLayoutProperty('osm', 'visibility')") == 'visible'

            # Switching store loads that store's own 30 racks.
            await page.locator('[data-store-id="2544"]').click()
            await page.wait_for_function(f"inventory.storeId === '2544' && inventory.model && inventory.racks.size === {expected['2544']}")
            assert await page.evaluate("inventory.unlinked.length") == 0
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

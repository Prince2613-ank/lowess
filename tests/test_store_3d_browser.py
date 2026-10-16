"""Browser checks for the 2.5D / 3D store view (frontend/store-3d.js)."""
import asyncio
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
STORE_ID = '1665'
LAYERS = "STORE_3D_LAYERS.map(id => state.map.getLayer(id) ? state.map.getLayoutProperty(id, 'visibility') : 'missing')"


def _store_entry():
    store = json.loads((ROOT / 'stores' / STORE_ID / 'store.json').read_text(encoding='utf-8'))
    return {**store, 'store_id': STORE_ID, 'state': 'Connecticut', 'state_code': 'CT', 'map_file': 'saved', 'indoor_map_status': 'success'}


def _store_map():
    files = {'Lowes_aisle': 'aisle', 'Lowes_depertment': 'department', 'Lowes_rack': 'rack'}
    return {key: json.loads((ROOT / 'stores' / STORE_ID / f'{name}.geojson').read_text(encoding='utf-8')) for key, name in files.items()}


def test_store_3d_view_extrudes_racks_and_animates_the_route():
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
                return self.send(200, json.dumps({'stores': [_store_entry()]}).encode())
            if path == '/api/catalog/report':
                return self.send(200, b'{}')
            if path == f'/api/catalog/stores/{STORE_ID}/map':
                return self.send(200, json.dumps(_store_map()).encode())
            if path == f'/api/catalog/stores/{STORE_ID}/details':
                return self.send(200, json.dumps(_store_entry()).encode())
            file = (ROOT / 'frontend' / path.lstrip('/')).resolve() if path != '/' else ROOT / 'frontend/index.html'
            if ROOT / 'frontend' in file.parents and file.is_file():
                return self.send(200, file.read_bytes(), mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
            self.send(404, b'{"error":"not found"}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://127.0.0.1:{server.server_port}/'

    async def verify():
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            page = await browser.new_page(viewport={'width': 1600, 'height': 960})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.route('https://**/*', lambda route: route.abort())
            await page.goto(url)
            await page.wait_for_function("inventory.model && inventory.racks.size > 0 && picking.store && picking.network")
            toggle = page.locator('.store-3d-toggle')

            # Flat and north-up by default; no rotating until 3D is on.
            assert await toggle.get_attribute('aria-pressed') == 'false'
            assert await page.evaluate("[state.map.getPitch(), state.map.getBearing(), state.map.dragRotate.isEnabled()]") == [0, 0, False]

            # 3D on: tilted, rotatable, store extruded.
            await page.locator('#ops-tab-picking').click()
            await toggle.click()
            await page.wait_for_timeout(1500)
            assert await toggle.get_attribute('aria-pressed') == 'true'
            pitch, rotate = await page.evaluate("[state.map.getPitch(), state.map.dragRotate.isEnabled()]")
            assert pitch > 40 and rotate
            assert await page.evaluate(LAYERS) == ['visible'] * 8
            assert await page.evaluate("state.map.getLayer('store3d-stock').type") == 'fill-extrusion'
            # Flat route highlights give way to the 3D rack caps; the route line stays.
            assert await page.evaluate("state.map.getLayoutProperty('picking-target-fill', 'visibility')") == 'none'
            assert await page.evaluate("state.map.getLayoutProperty('picking-route-line', 'visibility')") == 'visible'

            # The cart moves along the selected route.
            assert await page.evaluate("store3d.route && store3d.route.length > 10")
            first = await page.evaluate("JSON.stringify(state.map.getSource('store3d-cart')._data)")
            await page.wait_for_timeout(900)
            assert await page.evaluate("JSON.stringify(state.map.getSource('store3d-cart')._data)") != first

            # Rack Inventory tab: racks stay 3D, the route and cart are hidden.
            await page.locator('#ops-tab-inventory').click()
            await page.wait_for_timeout(300)
            visibility = dict(zip(await page.evaluate("STORE_3D_LAYERS"), await page.evaluate(LAYERS)))
            assert visibility['store3d-stock'] == 'visible' and visibility['store3d-cart'] == 'none'

            # 3D off: back to flat, north-up, no rotating, flat highlights back.
            await page.locator('#ops-tab-picking').click()
            await toggle.click()
            await page.wait_for_timeout(1200)
            assert await page.evaluate("[state.map.getPitch(), state.map.getBearing(), state.map.dragRotate.isEnabled()]") == [0, 0, False]
            assert set(await page.evaluate(LAYERS)) == {'none'}
            assert await page.evaluate("state.map.getLayoutProperty('picking-target-fill', 'visibility')") == 'visible'
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

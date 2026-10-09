"""Browser UI regression with existing Bloomfield and explicit synthetic stores."""
import asyncio
import json
import mimetypes
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


def test_frontend_switch_search_filters_layers_race_and_missing_maps():
    bloomfield = {**json.loads((ROOT/'data/stores.json').read_text())[0], 'state':'CT','city':'Bloomfield','zip':'06002','map_file':'existing','map_status':'imported'}
    synthetic = {'store_id':'99001','name':'Synthetic Alabama test store','state':'AL','city':'Test City','zip':'12345','address':'Synthetic address','latitude':33.2,'longitude':-86.8,'map_file':'fixture','map_status':'downloaded'}
    missing = {**synthetic, 'store_id':'99002','name':'Synthetic no-map store','map_file':None}
    bad = {**synthetic, 'store_id':'99003','name':'Synthetic malformed store'}
    requests = []
    alignments = {}
    legacy = {path.stem: json.loads(path.read_text()) for path in ROOT.glob('Lowes_*.geojson')}
    feature = {'type':'Feature','properties':{'name':'<img src=x onerror=alert(1)>'},'geometry':{'type':'Polygon','coordinates':[[[-86.8,33.2],[-86.799,33.2],[-86.799,33.201],[-86.8,33.201],[-86.8,33.2]]]}}
    fixture = {k:{'type':'FeatureCollection','features':[feature]} for k in ('department','aisle','rack')}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            value = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            alignments[self.path] = value
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(value).encode())

        def do_GET(self):
            path = self.path.split('?')[0]
            requests.append(path)
            status, content_type = 200, 'application/json'
            if path.endswith('/debug-georeference'):
                value = alignments.get(path, {})
            elif path == '/api/catalog/stores':
                value = {'stores':[bloomfield,synthetic,missing,bad]}
            elif path == '/api/catalog/report': value = {}
            elif path == '/api/catalog/stores/1665/map': value = legacy
            elif path == '/api/catalog/stores/99001/map':
                time.sleep(.4)
                value = fixture
            elif path == '/api/catalog/stores/99003/map': value = {'bad':'data'}
            else:
                file = (ROOT/'frontend'/path.lstrip('/')).resolve() if path != '/' else ROOT/'frontend/index.html'
                if ROOT/'frontend' in file.parents and file.is_file():
                    payload = file.read_bytes()
                    content_type = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
                    self.send_response(200); self.send_header('Content-Type',content_type); self.end_headers(); self.wfile.write(payload); return
                status, value = 404, {'error':'not found'}
            payload = json.dumps(value).encode()
            self.send_response(status); self.send_header('Content-Type',content_type); self.end_headers(); self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()

    async def verify():
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel='chrome',headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])  # WebGL for MapLibre
            page = await browser.new_page(viewport={'width':1440,'height':900})
            errors=[]
            page.on('pageerror',lambda e: errors.append(str(e)))
            await page.route('https://**/*',lambda route: route.abort())  # local assets; no tile/network dependency
            await page.goto(f'http://127.0.0.1:{server.server_port}/')
            await page.wait_for_function("document.querySelector('#map-status').textContent === 'Indoor map ready'")
            assert await page.evaluate("state.layers.data.departments.features.length") > 0
            assert '/api/catalog/stores/99001/map' not in requests  # lazy loading
            await page.locator('#store-search').fill('99001')
            assert await page.locator('.store-result').count() == 1
            await page.locator('.store-result').click()
            await page.wait_for_function("state.currentStoreId === '99001' && document.querySelector('#map-status').textContent === 'Indoor map ready'")
            assert abs(await page.evaluate('state.map.getCenter().lng') + 86.7995) < .01
            assert await page.locator('.dept-label img').count() == 0  # escaped remote labels
            await page.locator('#layer-department').uncheck()
            assert not await page.evaluate("isLayerVisible('departments')")
            await page.locator('#layer-department').check()
            assert await page.evaluate("isLayerVisible('departments')")
            await page.locator('#layer-satellite').uncheck()
            assert await page.evaluate("state.map.getLayoutProperty('osm', 'visibility') === 'visible'")
            await page.locator('#store-search').fill('')
            await page.locator('#state-filter').select_option('AL')
            assert await page.locator('.store-result').count() == 3
            await page.locator('#city-filter').select_option('Test City')
            await page.locator('[data-store-id="99002"]').click()
            assert await page.locator('#map-status').inner_text() == 'Indoor map unavailable'
            assert await page.evaluate('state.layers.data.departments.features.length') == 0
            # Late map response must not replace a newer selection.
            await page.evaluate("directory.cache.delete('99001'); loadStore('99001'); loadStore('99002');")
            await page.wait_for_timeout(650)
            assert await page.evaluate('state.currentStoreId') == '99002'
            assert await page.evaluate('state.layers.data.departments.features.length') == 0
            await page.locator('[data-store-id="99003"]').click()
            await page.wait_for_function("document.querySelector('#map-status').textContent === 'Indoor map failed'")
            await page.locator('#state-filter').select_option('CT')
            await page.locator('[data-store-id="1665"]').click()
            await page.wait_for_function("document.querySelector('#map-status').textContent === 'Indoor map ready'")
            assert await page.evaluate('state.layers.data.departmentLines.features.length') >= 0
            assert await page.evaluate('state.layers.markerGroup.getLayers().length') > 0
            # The corner adjustment tool is gone; the saved alignment still loads.
            assert await page.locator('#debug-panel, #layer-debug, .debug-corner-marker').count() == 0
            assert await page.evaluate("typeof adjustDebug === 'undefined' && !state.map.getLayer('debug-corners-line')")
            expected = await page.evaluate('JSON.parse(JSON.stringify(state.currentStore.debugGeoreference))')
            bounds = await page.evaluate('JSON.stringify(directory.bounds.toArray())')
            await page.reload()
            await page.wait_for_function("document.querySelector('#map-status').textContent === 'Indoor map ready'")
            assert await page.evaluate('state.currentStore.debugGeoreference') == expected
            assert await page.evaluate('JSON.stringify(directory.bounds.toArray())') == bounds
            other = await browser.new_page()
            await other.route('https://**/*', lambda route: route.abort())
            await other.goto(f'http://127.0.0.1:{server.server_port}/')
            await other.wait_for_function("document.querySelector('#map-status').textContent === 'Indoor map ready'")
            assert await other.evaluate('JSON.stringify(directory.bounds.toArray())') == bounds
            assert not errors
            await browser.close()
    try: asyncio.run(verify())
    finally:
        server.shutdown(); server.server_close(); thread.join()

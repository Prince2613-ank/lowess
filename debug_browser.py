import asyncio, json, mimetypes, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(r'c:\Users\Flodata Analytics\lowes')

bloomfield = {**json.loads((ROOT/'data/stores.json').read_text())[0], 'state':'CT','city':'Bloomfield','zip':'06002','map_file':'existing','map_status':'imported'}
synthetic = {'store_id':'99001','name':'Synthetic Alabama test store','state':'AL','city':'Test City','zip':'12345','address':'Synthetic address','latitude':33.2,'longitude':-86.8,'map_file':'fixture','map_status':'downloaded'}
missing = {**synthetic, 'store_id':'99002','name':'Synthetic no-map store','map_file':None}
bad = {**synthetic, 'store_id':'99003','name':'Synthetic malformed store'}
legacy = {path.stem: json.loads(path.read_text()) for path in ROOT.glob('Lowes_*.geojson')}
feature = {'type':'Feature','properties':{'name':'<img src=x onerror=alert(1)>'},'geometry':{'type':'Polygon','coordinates':[[[-86.8,33.2],[-86.799,33.2],[-86.799,33.201],[-86.8,33.201],[-86.8,33.2]]]}}
fixture = {k:{'type':'FeatureCollection','features':[feature]} for k in ('department','aisle','rack')}
requests=[]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        path = self.path.split('?')[0]
        requests.append(path)
        status, content_type = 200, 'application/json'
        if path == '/api/catalog/stores':
            value = {'stores':[bloomfield,synthetic,missing,bad]}
        elif path == '/api/catalog/report':
            value = {}
        elif path == '/api/catalog/stores/1665/map':
            value = legacy
        elif path == '/api/catalog/stores/99001/map':
            time.sleep(.4)
            value = fixture
        elif path == '/api/catalog/stores/99003/map':
            value = {'bad':'data'}
        else:
            file = (ROOT/'frontend'/path.lstrip('/')).resolve() if path != '/' else ROOT/'frontend/index.html'
            if ROOT/'frontend' in file.parents and file.is_file():
                payload = file.read_bytes()
                content_type = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
                self.send_response(200); self.send_header('Content-Type',content_type); self.end_headers(); self.wfile.write(payload); return
            status, value = 404, {'error':'not found'}
        body = json.dumps(value).encode()
        self.send_response(status); self.send_header('Content-Type',content_type); self.end_headers(); self.wfile.write(body)

server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='chrome', headless=True)
        page = await browser.new_page(viewport={'width':1440,'height':900})
        await page.goto(f'http://127.0.0.1:{server.server_port}/?maptest=3')
        await page.wait_for_function("document.querySelector('#map-status').textContent === 'Indoor map ready'")
        await page.locator('#debug-mode').check()
        await page.locator('#corner-mode').check()
        await page.wait_for_function("document.querySelectorAll('.debug-corner-marker').length === 4")
        print('corners', await page.evaluate("Array.from(document.querySelectorAll('.debug-corner-marker')).map(el => el.textContent.trim()).join(',')"))
        print('initial', await page.evaluate('({current: state.currentStoreId, center: state.map.getCenter(), location: directory.location})'))
        await page.locator('#store-search').fill('99001')
        print('count', await page.locator('.store-result').count())
        await page.locator('.store-result').click()
        print('after click immediate', await page.evaluate('({current: state.currentStoreId, center: state.map.getCenter(), location: directory.location, generation: directory.generation})'))
        await page.wait_for_function("state.currentStoreId === '99001' && document.querySelector('#map-status').textContent === 'Indoor map ready'")
        print('after wait', await page.evaluate('({current: state.currentStoreId, center: state.map.getCenter(), location: directory.location, generation: directory.generation})'))
        await page.locator('#store-search').fill('')
        await page.locator('#state-filter').select_option('AL')
        await page.locator('#city-filter').select_option('Test City')
        await page.locator('[data-store-id="99002"]').click()
        print('after missing click', await page.evaluate('({current: state.currentStoreId, status: document.querySelector("#map-status").textContent, layers: state.layers.departments.getLayers().length, generation: directory.generation})'))
        await page.wait_for_timeout(500)
        print('after 500', await page.evaluate('({current: state.currentStoreId, status: document.querySelector("#map-status").textContent, layers: state.layers.departments.getLayers().length, generation: directory.generation})'))
        print('requests', requests)
        await browser.close()

asyncio.run(main())
server.shutdown(); server.server_close(); thread.join()

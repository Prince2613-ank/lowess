"""Real Chrome/HTTP integration using a local, explicitly synthetic directory."""
import asyncio
import json
import sys
import threading
from argparse import Namespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lowes_pipeline import runner


def test_browser_discovery_capture_resume_force_and_failure(tmp_path, monkeypatch):
    records = {'901': ('AL','Sample',33.2,-86.8), '902': ('AL','Sample',33.3,-86.7),
               '903': ('AZ','Example',33.4,-112.0), '904': ('AZ','Broken',33.5,-112.1)}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            path = self.path
            requests.append(path)
            status, content_type, value = 200, 'text/html', ''
            if path == '/Lowes-Stores':
                value = '<a href="/Lowes-Stores/Alabama/AL">Alabama</a><a href="/Lowes-Stores/Arizona/AZ">Arizona</a>'
            elif path == '/Lowes-Stores/Alabama/AL':
                value = '<button onclick="this.insertAdjacentHTML(\'afterend\',\'<a href=/store/AL-Sample/901>Sample</a><a href=/store/AL-Sample/902>Sample</a>\');this.disabled=true">Sample (2 Stores)</button>'
            elif path == '/Lowes-Stores/Arizona/AZ':
                value = '<a href="/store/AZ-Example/903">Example</a><a href="/store/AZ-Broken/904">Broken</a>'
            elif path.startswith('/store/'):
                sid = path.split('/')[-1]
                region, city, lat, lon = records[sid]
                meta = {'@type':'HardwareStore','name':f'Fixture {sid}', 'address': {'streetAddress':'1 Test Road','addressLocality':city,'addressRegion':region,'postalCode':'12345'}, 'geo': {'latitude':lat, 'longitude':lon}}
                value = '<h1>Fixture</h1><script type="application/ld+json">'+json.dumps(meta)+'</script>'
                if sid != '903':
                    value += f'<button onclick="fetch(\'/payload/{sid}\')">Store Map</button>'
            elif path.startswith('/payload/'):
                sid = path.split('/')[-1]
                _, _, lat, lon = records[sid]
                feature = {'type':'Feature', 'properties':{'label':f'Aisle {sid}'}, 'geometry':{'type':'Polygon','coordinates':[[[lon,lat],[lon+.001,lat],[lon+.001,lat+.001],[lon,lat+.001],[lon,lat]]]}}
                value = {'department':{'type':'FeatureCollection','features':[feature]}, 'aisle':{'type':'FeatureCollection','features':[feature]}, 'rack':{'type':'FeatureCollection','features':[feature]}, 'sourceMetadata': {'store':sid}}
                if sid == '904':
                    value['rack']['features'] = [{}]
                value = json.dumps(value)
                content_type = 'text/plain'
            else:
                status, value = 404, 'Not found'
            payload = value.encode()
            self.send_response(status); self.send_header('Content-Type',content_type); self.send_header('Content-Length',str(len(payload))); self.end_headers(); self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    monkeypatch.setattr(runner, 'ROOT', tmp_path / 'no-legacy')
    args = Namespace(base_url=f'http://127.0.0.1:{server.server_port}', output=tmp_path/'data', workers=2, delay=.5, timeout=5,
                     retries=0,map_wait=.8,cache_hours=24,channel='chrome',headed=False,force=False,refresh_discovery=False,states='',store_ids='',limit=0)
    try:
        assert asyncio.run(runner.run(args)) == 1  # intentionally malformed store
        report = json.loads((args.output/'pipeline-report.json').read_text())
        assert (report['states_discovered'],report['cities_discovered'],report['stores_discovered']) == (2,3,4)
        assert (report['maps_downloaded'],report['maps_failed'],report['no_map_available']) == (2,1,1)
        saved = json.loads((args.output/'stores/AL/901/map.geojson').read_text())
        assert saved['sourceMetadata']['store'] == '901' and set(saved) >= {'department','aisle','rack'}
        assert '/payload/901' in requests
        args.store_ids = '901,902'
        before = len([r for r in requests if r.startswith('/payload/')])
        assert asyncio.run(runner.run(args, 'download')) == 0
        report = json.loads((args.output/'pipeline-report.json').read_text())
        assert report['maps_skipped'] == 2
        assert len([r for r in requests if r.startswith('/payload/')]) == before
        args.force = True
        assert asyncio.run(runner.run(args, 'download')) == 0
        assert json.loads((args.output/'pipeline-report.json').read_text())['maps_downloaded'] == 2
    finally:
        server.shutdown(); server.server_close(); thread.join()

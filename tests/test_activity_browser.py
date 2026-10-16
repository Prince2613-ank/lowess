"""Picking activity heatmap: the built data and the Activity tab."""
import asyncio
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "frontend" / "data"
STORE_ID = "1665"


def test_activity_data_matches_racks_and_walking_network():
    stores = json.loads((DATA / "metrics" / "stores.json").read_text(encoding="utf-8"))["stores"]
    for store in stores:
        sid = store["store_id"]
        data = json.loads((DATA / "activity" / f"{sid}.json").read_text(encoding="utf-8"))
        inventory = json.loads((DATA / "inventory" / f"{sid}.json").read_text(encoding="utf-8"))
        routing = json.loads((DATA / "routing" / f"{sid}.json").read_text(encoding="utf-8"))
        racks = {rack["rack_id"] for rack in inventory["racks"]}
        assert set(data["rack_lines"]) <= racks, sid
        assert all(len(weeks) == data["weeks"] == 12 and min(weeks) >= 0 for weeks in data["rack_lines"].values()), sid
        traffic = data["traffic"]
        assert traffic["trips_simulated"] == 400 and traffic["trips_per_week"] > 0, sid
        assert 50 < traffic["trip_m_mean"] < 2000, sid
        # Heat cells lie on the store's walking grid (within its bounding box).
        grid, proj = routing["grid"], routing["projection"]
        to_xy = lambda lng, lat: ((lng - proj["lon0"]) * proj["kx"], (lat - proj["lat0"]) * proj["ky"])
        for lng, lat, passes in traffic["points"][:: max(1, len(traffic["points"]) // 200)]:
            x, y = to_xy(lng, lat)
            assert grid["x0"] - 1 <= x <= grid["x0"] + grid["cols"] * grid["cell"] + 1, sid
            assert grid["y0"] - 1 <= y <= grid["y0"] + grid["rows"] * grid["cell"] + 1, sid
            assert passes > 0


def _store_entry():
    store = json.loads((ROOT / "stores" / STORE_ID / "store.json").read_text(encoding="utf-8"))
    return {**store, "store_id": STORE_ID, "state": "Connecticut", "state_code": "CT", "map_file": "saved", "indoor_map_status": "success"}


def _store_map():
    files = {"Lowes_aisle": "aisle", "Lowes_depertment": "department", "Lowes_rack": "rack"}
    return {key: json.loads((ROOT / "stores" / STORE_ID / f"{name}.geojson").read_text(encoding="utf-8")) for key, name in files.items()}


def test_activity_tab_heatmap_and_rankings():
    data = json.loads((DATA / "activity" / f"{STORE_ID}.json").read_text(encoding="utf-8"))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def send(self, status, payload, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path.endswith("/debug-georeference"):
                return self.send(200, b"{}")
            if path == "/api/catalog/stores":
                return self.send(200, json.dumps({"stores": [_store_entry()]}).encode())
            if path == "/api/catalog/report":
                return self.send(200, b"{}")
            if path == f"/api/catalog/stores/{STORE_ID}/map":
                return self.send(200, json.dumps(_store_map()).encode())
            if path == f"/api/catalog/stores/{STORE_ID}/details":
                return self.send(200, json.dumps(_store_entry()).encode())
            file = (ROOT / "frontend" / path.lstrip("/")).resolve() if path != "/" else ROOT / "frontend/index.html"
            if ROOT / "frontend" in file.parents and file.is_file():
                return self.send(200, file.read_bytes(), mimetypes.guess_type(str(file))[0] or "application/octet-stream")
            self.send(404, b'{"error":"not found"}')

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/"

    async def verify():
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            page = await browser.new_page(viewport={"width": 1600, "height": 960})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.route("https://**/*", lambda route: route.abort())
            await page.goto(url)
            await page.wait_for_function("inventory.model && inventory.racks.size > 0")

            # Fourth tab; loads on demand, last 4 weeks by default, both layers on.
            assert await page.locator(".ops-tabs [role=tab]").count() == 4
            await page.locator("#ops-tab-activity").click()
            await page.wait_for_function("activity.data && activity.rackTotals.size > 0")
            assert await page.locator("#inventory-title").inner_text() == "Picking Activity"
            assert await page.evaluate("[state.map.getLayoutProperty('activity-rack-fill', 'visibility'), state.map.getLayoutProperty('activity-traffic-heat', 'visibility')]") == ["visible", "visible"]
            assert await page.evaluate("state.map.getSource('activity-traffic')._data.features.length") == len(data["traffic"]["points"])

            # Pick lines in the tile = the data for the period.
            expected = round(sum(sum(weeks[-4:]) for weeks in data["rack_lines"].values()))
            tile = await page.locator(".activity-stat strong").first.inner_text()
            assert int(tile.replace(",", "")) == expected
            await page.locator('#activity-period button[data-weeks="12"]').click()
            expected12 = round(sum(sum(weeks) for weeks in data["rack_lines"].values()))
            assert int((await page.locator(".activity-stat strong").first.inner_text()).replace(",", "")) == expected12

            # Rankings are ordered; clicking a rack selects it on the map.
            aisle_values = [int(v.replace(",", "")) for v in await page.locator(".activity-bar-value").all_inner_texts()]
            assert aisle_values == sorted(aisle_values, reverse=True) and len(aisle_values) <= 10
            rack_values = [int(v.replace(",", "")) for v in await page.locator("#activity-racks td:nth-child(3)").all_inner_texts()]
            assert rack_values == sorted(rack_values, reverse=True)
            first = await page.locator("#activity-racks td.rack").first.inner_text()
            await page.locator("#activity-racks tr").first.click()
            assert await page.evaluate("inventory.selectedId") == first

            # Busiest racks are in the darkest class.
            assert await page.evaluate(f"activityClass(activity.rackTotals.get('{first}'))") == 5

            # Layer switches; racks go neutral instead of falling back to occupancy colours.
            await page.locator("#activity-show-traffic").uncheck()
            assert await page.evaluate("state.map.getLayoutProperty('activity-traffic-heat', 'visibility')") == "none"
            await page.locator("#activity-show-racks").uncheck()
            assert await page.evaluate("state.map.getPaintProperty('activity-rack-fill', 'fill-color')") == "#eef2f7"

            # Leaving the tab hides both layers.
            await page.locator("#ops-tab-inventory").click()
            assert await page.evaluate("[state.map.getLayoutProperty('activity-rack-fill', 'visibility'), state.map.getLayoutProperty('activity-traffic-heat', 'visibility')]") == ["none", "none"]
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

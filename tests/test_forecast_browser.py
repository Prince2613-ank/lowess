"""SKU demand forecast: the built data and the Forecast tab."""
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


def test_forecast_data_covers_every_sku_and_backtests_well():
    stores = json.loads((DATA / "metrics" / "stores.json").read_text(encoding="utf-8"))["stores"]
    for store in stores:
        sid = store["store_id"]
        data = json.loads((DATA / "forecast" / f"{sid}.json").read_text(encoding="utf-8"))
        inventory = json.loads((DATA / "inventory" / f"{sid}.json").read_text(encoding="utf-8"))
        skus = {p["sku"]: rack["rack_id"] for rack in inventory["racks"] for p in rack["products"]}
        assert {row[0] for row in data["skus"]} == set(skus), sid
        assert all(skus[row[0]] == row[1] and row[2] >= 0 and row[4] > 0 and len(row[5]) == 12 for row in data["skus"]), sid
        assert len(data["weekday_index"]) == 7 and data["simulated"] is True
        # Out-of-sample check on the last 14 days of history.
        assert data["model"]["backtest"]["wape"] < 0.35 and abs(data["model"]["backtest"]["bias"]) < 0.15, sid


def _store_entry():
    store = json.loads((ROOT / "stores" / STORE_ID / "store.json").read_text(encoding="utf-8"))
    return {**store, "store_id": STORE_ID, "state": "Connecticut", "state_code": "CT", "map_file": "saved", "indoor_map_status": "success"}


def _store_map():
    files = {"Lowes_aisle": "aisle", "Lowes_depertment": "department", "Lowes_rack": "rack"}
    return {key: json.loads((ROOT / "stores" / STORE_ID / f"{name}.geojson").read_text(encoding="utf-8")) for key, name in files.items()}


def test_forecast_tab_ranks_run_outs_and_follows_live_stock():
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
            page.on("dialog", lambda dialog: asyncio.ensure_future(dialog.accept()))  # "Reset inventory" asks first
            await page.route("https://**/*", lambda route: route.abort())
            await page.goto(url)
            await page.wait_for_function("inventory.model && inventory.racks.size > 0")
            assert await page.evaluate("state.map.getLayer('forecast-risk-fill') ? state.map.getLayoutProperty('forecast-risk-fill', 'visibility') : 'none'") == "none"

            # Third tab: the forecast loads on demand, 14 days by default.
            await page.locator("#ops-tab-forecast").click()
            await page.wait_for_function("forecast.data && forecast.rows.length > 0")
            assert await page.locator("#inventory-title").inner_text() == "Demand Forecast"
            assert await page.locator('#forecast-horizon button[aria-pressed="true"]').inner_text() == "14 days"
            assert await page.locator(".forecast-stat").count() == 4
            assert await page.evaluate("state.map.getLayoutProperty('forecast-risk-fill', 'visibility')") == "visible"

            # The list is ordered by run-out day and shows only likely / at-risk SKUs by default.
            listed = await page.evaluate("filteredForecastRows().slice(0, 40).map(r => [r.runOut ?? 999, r.risk])")
            assert listed and [d for d, _ in listed] == sorted(d for d, _ in listed)
            assert {risk for _, risk in listed} <= {"high", "medium"}

            # A longer horizon can only add risk.
            counts = {}
            for days in (7, 30):
                await page.locator(f'#forecast-horizon button[data-days="{days}"]').click()
                counts[days] = await page.evaluate("forecast.rows.filter(r => r.risk === 'high').length")
            assert counts[30] >= counts[7]

            # Selecting a product shows its history and selects its rack on the map.
            await page.locator("#forecast-table-body tr").first.click()
            assert await page.locator("#forecast-details").is_visible()
            assert await page.locator(".forecast-week").count() == 12
            assert await page.evaluate("inventory.selectedId === forecast.rows.find(r => r.sku === forecast.selectedSku).rack.rack_id")

            # Live stock: emptying a healthy SKU's shelf makes it "out", restocking makes it safe.
            sku, rack = await page.evaluate("(() => { const r = forecast.rows.find(r => r.risk === 'low' && r.stock > 5); return [r.sku, r.rack.rack_id]; })()")
            await page.evaluate(f"(() => {{ const p = inventory.model.get('{rack}').products.find(p => p.sku === '{sku}'); inventory.model.changeStock('{rack}', '{sku}', -p.stock_quantity); }})()")
            assert await page.evaluate(f"forecast.rows.find(r => r.sku === '{sku}').risk") == "out"
            await page.locator("#inventory-reset-all").evaluate("b => b.click()")
            assert await page.evaluate(f"forecast.rows.find(r => r.sku === '{sku}').risk") == "low"

            # Leaving the tab hides the risk colours again.
            await page.locator("#ops-tab-inventory").click()
            assert await page.evaluate("state.map.getLayoutProperty('forecast-risk-fill', 'visibility')") == "none"
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

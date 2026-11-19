"""BLE beacon tracking: the built beacon layouts and the Tracking tab."""
import asyncio
import base64
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "frontend" / "data"
STORE_ID = "1665"


def _walkable(grid):
    mask = np.unpackbits(np.frombuffer(base64.b64decode(grid["mask"]), dtype=np.uint8), bitorder="little")
    return mask[: grid["cols"] * grid["rows"]].astype(bool)


def test_beacon_layouts_sit_on_the_walking_floor():
    stores = sorted(p.stem for p in (DATA / "routing").glob("*.json"))
    assert len(stores) == 16
    for sid in stores:
        data = json.loads((DATA / "beacons" / f"{sid}.json").read_text(encoding="utf-8"))
        routing = json.loads((DATA / "routing" / f"{sid}.json").read_text(encoding="utf-8"))
        grid, proj = routing["grid"], routing["projection"]
        walkable = _walkable(grid)
        beacons = data["beacons"]
        assert data["simulated"] is True and 10 <= len(beacons) <= 15, sid
        assert len({b["id"] for b in beacons}) == len(beacons), sid
        for beacon in beacons:
            assert walkable[beacon["cell"]], (sid, beacon["id"])
            # The position is the centre of its cell.
            x = (beacon["position"][0] - proj["lon0"]) * proj["kx"]
            y = (beacon["position"][1] - proj["lat0"]) * proj["ky"]
            r, c = divmod(beacon["cell"], grid["cols"])
            assert abs(x - (grid["x0"] + (c + 0.5) * grid["cell"])) < 0.01 and abs(y - (grid["y0"] + (r + 0.5) * grid["cell"])) < 0.01, (sid, beacon["id"])
            assert beacon["tx_power_dbm"] == data["model"]["tx_power_dbm"] and abs(beacon["tx_offset_db"]) <= 2
            assert 0 < beacon["battery_pct"] <= 100
        # One beacon in every back-of-house area of the store.
        zones = json.loads((DATA / "zones" / f"{sid}.json").read_text(encoding="utf-8"))["zones"]
        assert sorted(b["zone_type"] for b in beacons if b["zone_type"]) == sorted(z["type"] for z in zones), sid
        # Zone grid: run-length cells cover the walking grid exactly; back-of-house areas are zones.
        runs = data["zones"]["cells"]
        assert sum(runs[1::2]) == grid["cols"] * grid["rows"], sid
        labels = data["zones"]["labels"]
        assert labels[0] == "Main aisles" and max(runs[0::2]) < len(labels), sid
        assert {"Pack & Dispatch", "Receiving Area"} <= set(labels) and "Unassigned" not in labels, sid
        # Most of the floor hears enough beacons to be positioned.
        assert data["coverage"]["share_3plus"] >= 0.8 and data["coverage"]["share_1plus"] >= 0.99, sid


def _store_entry():
    store = json.loads((ROOT / "stores" / STORE_ID / "store.json").read_text(encoding="utf-8"))
    return {**store, "store_id": STORE_ID, "state": "Connecticut", "state_code": "CT", "map_file": "saved", "indoor_map_status": "success"}


def _store_map():
    files = {"Lowes_aisle": "aisle", "Lowes_depertment": "department", "Lowes_rack": "rack"}
    return {key: json.loads((ROOT / "stores" / STORE_ID / f"{name}.geojson").read_text(encoding="utf-8")) for key, name in files.items()}


def test_tracking_tab_positions_scans_and_verifies_picks():
    beacons = json.loads((DATA / "beacons" / f"{STORE_ID}.json").read_text(encoding="utf-8"))["beacons"]

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
    url = f"http://127.0.0.1:{server.server_port}/?reset=1"

    async def verify():
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            page = await browser.new_page(viewport={"width": 1600, "height": 960})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.route("https://**/*", lambda route: route.abort())
            await page.goto(url)
            await page.wait_for_function("inventory.model && inventory.racks.size > 0 && trackingReady()")
            await page.evaluate("tracking.running = false")      # the test steps the simulation itself

            # Fifth tab: beacons and every cart and staff member on the map.
            assert await page.locator(".ops-tabs [role=tab]").count() == 5
            await page.locator("#ops-tab-tracking").click()
            assert await page.locator("#inventory-title").inner_text() == "Live Tracking"
            assert await page.locator(".tracking-beacon").count() == len(beacons)
            assert await page.locator(".tracking-tag-row").count() == 7      # 3 carts, 4 staff
            assert await page.locator(".tracking-tag").count() == 7
            assert await page.evaluate("state.map.getLayoutProperty('tracking-accuracy-fill', 'visibility')") == "visible"

            # Positions come from the simulated readings, with an accuracy and a confidence class.
            await page.evaluate("trackingAdvance(180)")
            check = await page.evaluate("""() => tracking.tags.map(t => ({ acc: t.est.accuracy, conf: t.est.confidence,
                err: Math.hypot(t.est.x - t.x, t.est.y - t.y), walkable: tracking.floor.isWalkable(t.est.x, t.est.y) }))""")
            assert all(c["walkable"] and c["acc"] >= 1 and c["conf"] in ("high", "medium", "low") for c in check)
            assert await page.evaluate("median(tracking.check.errors)") < 8
            assert await page.evaluate("tracking.events.filter(e => e.kind === 'zone').length") > 0
            assert "±" in await page.locator("#tracking-stat-accuracy").inner_text()

            # True position (simulation only) can be switched off.
            await page.locator("#tracking-show-truth").uncheck()
            assert await page.evaluate("state.map.getLayoutProperty('tracking-truth', 'visibility')") == "none"
            await page.locator("#tracking-show-truth").check()

            # A started cart walks to its first stop and asks for the scan, with the beacon check.
            await page.evaluate("picking.store.startPicking('CART-01')")
            at_stop = await page.evaluate("""() => { const t = tracking.tags.find(t => t.id === 'CART-01');
                for (let i = 0; i < 300 && t.state !== 'at-stop'; i++) trackingAdvance(2);
                trackingAdvance(4); return t.state === 'at-stop' ? t.target.rackId : null; }""")
            assert at_stop
            card = page.locator('.tracking-scan[data-tag-id="CART-01"]')
            assert await card.count() == 1
            assert at_stop in await card.inner_text()
            picks = await page.evaluate("Object.keys(picking.store.state.picks).length")
            await card.locator("button").click()
            assert await page.evaluate("Object.keys(picking.store.state.picks).length") > picks
            checked = await page.evaluate("[...tracking.verifications.values()]")
            assert checked and all(isinstance(v["verified"], bool) for v in checked)
            assert await page.evaluate("tracking.events.some(e => e.kind === 'scan')")
            assert await page.evaluate("tracking.tags.find(t => t.id === 'CART-01').state") == "walking"

            # Simulated pickers: the cart finishes its route and is back at Pack & Dispatch.
            await page.locator("#tracking-auto-scan").check()
            done = await page.evaluate("""() => { const t = tracking.tags.find(t => t.id === 'CART-01');
                const status = () => picking.store.cartSummary(picking.store.cart('CART-01')).status;
                for (let i = 0; i < 400 && !(t.state === 'parked' && status() === 'Returning'); i++) trackingAdvance(5);
                return [t.state, status(), tracking.verifications.size]; }""")
            assert done[0] == "parked" and done[1] == "Returning"
            lines = await page.evaluate("picking.store.cartSummary(picking.store.cart('CART-01')).orders.reduce((n, o) => n + o.lines.length, 0)")
            assert done[2] >= lines
            share = await page.evaluate("[...tracking.verifications.values()].filter(v => v.verified).length / tracking.verifications.size")
            assert share >= 0.6

            # The picking checklist shows each pick's beacon check.
            await page.locator("#ops-tab-picking").click()
            await page.locator('.picking-cart-card[data-cart-id="CART-01"]').click()
            assert await page.locator(".picking-checklist .tracking-verified").count() >= lines
            assert "Beacon position" in await page.locator("#picking-beacon-fix").inner_text()

            # Leaving the tab hides the tracking layers and markers.
            assert await page.evaluate("state.map.getLayoutProperty('tracking-accuracy-fill', 'visibility')") == "none"
            assert await page.locator(".tracking-tag").count() == 0
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

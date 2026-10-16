"""Store Comparison dashboard (compare.html) on the built metrics data."""
import asyncio
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "frontend" / "data"


def test_metrics_match_store_inventory():
    metrics = json.loads((DATA / "metrics" / "stores.json").read_text(encoding="utf-8"))
    assert len(metrics["stores"]) == 16
    for store in metrics["stores"]:
        inventory = json.loads((DATA / "inventory" / f"{store['store_id']}.json").read_text(encoding="utf-8"))
        products = [p for rack in inventory["racks"] for p in rack["products"]]
        assert store["inventory"]["out_of_stock"] == sum(p["stock_quantity"] == 0 for p in products)
        assert store["inventory"]["low_stock"] == sum(0 < p["stock_quantity"] <= p["reorder_point"] for p in products)
        assert store["inventory"]["racks"] == len(inventory["racks"])
        assert store["layout"]["walk_mean_m"] > 0
        daily = store["daily"]
        assert len(daily["orders"]) == metrics["days"] and all(c <= o for c, o in zip(daily["complete"], daily["orders"]))


def test_store_comparison_page_filters_focus_and_table():
    metrics = json.loads((DATA / "metrics" / "stores.json").read_text(encoding="utf-8"))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass

        def do_GET(self):
            path = self.path.split("?")[0]
            file = (ROOT / "frontend" / path.lstrip("/")).resolve()
            if ROOT / "frontend" in file.parents and file.is_file():
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(str(file))[0] or "application/octet-stream")
                self.end_headers()
                self.wfile.write(file.read_bytes())
            else:
                self.send_response(404)
                self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}/compare.html"
    total = lambda days, key: sum(sum(s["daily"][key][-days:]) for s in metrics["stores"])

    async def verify():
        async with async_playwright() as p:
            browser = await p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            page = await browser.new_page(viewport={"width": 1440, "height": 900})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            await page.route("https://**/*", lambda route: route.abort())
            await page.goto(url)
            await page.wait_for_function("cmp.rows && document.querySelectorAll('#chart-orders .bar-row').length === 16")

            # Defaults: last 30 days, every chart and the table list all stores.
            assert await page.locator('.cmp-period button[aria-pressed="true"]').inner_text() == "Last 30 days"
            for chart in ("orders", "productivity", "fulfillment", "stockouts"):
                assert await page.locator(f"#chart-{chart} .bar-row").count() == 16
            assert await page.locator("#cmp-table tbody tr").count() == 16
            assert await page.locator(".kpi").count() == 5
            orders_tile = page.locator(".kpi").nth(0).locator(".kpi-value")
            assert (await orders_tile.inner_text()).replace(",", "") == str(total(30, "orders"))
            oos = sum(s["inventory"]["out_of_stock"] for s in metrics["stores"])
            assert (await page.locator(".kpi").nth(4).locator(".kpi-value").inner_text()).replace(",", "") == str(oos)

            # Order volume bars are ranked highest first.
            values = [int(v.replace(",", "")) for v in await page.locator("#chart-orders .bar-value").all_inner_texts()]
            assert values == sorted(values, reverse=True)

            # Period filter scopes the tiles.
            await page.locator('.cmp-period button[data-days="7"]').click()
            assert (await orders_tile.inner_text()).replace(",", "") == str(total(7, "orders"))
            assert "days=7" in page.url

            # Focus a store: emphasised in every chart and the table, kept in the URL.
            await page.select_option("#cmp-focus", "2383")
            assert await page.locator("#chart-orders.has-focus .bar-row.focused").count() == 1
            assert "Cromwell" in await page.locator("#chart-orders .bar-row.focused").inner_text()
            assert await page.locator("#cmp-table tbody tr.focused").count() == 1
            assert "store=2383" in page.url
            assert await page.locator("#trend-legend span").count() == 2

            # Table sorts and links each store to its map.
            await page.locator("#cmp-table thead button", has_text="Out of stock").click()
            first = await page.locator("#cmp-table tbody tr").first.locator("td").nth(8).inner_text()
            assert int(first.replace(",", "")) == max(s["inventory"]["out_of_stock"] for s in metrics["stores"])
            assert await page.locator('#cmp-table a[href="./?store=2383"]').count() == 1

            # Hover shows a tooltip; the map page links here.
            await page.locator("#chart-orders .bar-row").first.hover()
            assert await page.locator("#cmp-tooltip").is_visible()
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

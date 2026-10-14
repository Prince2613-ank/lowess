"""Browser checks for online order picking and multi-cart routes on real store data."""
import asyncio
import json
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
STORE_ID = '1665'

IN_RING = """const inRing = ([x, y], ring) => { let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit; }
    return hit; };"""


def _store_entry():
    store = json.loads((ROOT / 'stores' / STORE_ID / 'store.json').read_text(encoding='utf-8'))
    return {**store, 'store_id': STORE_ID, 'state': 'Connecticut', 'state_code': 'CT', 'map_file': 'saved', 'indoor_map_status': 'success'}


def _store_map():
    files = {'Lowes_aisle': 'aisle', 'Lowes_depertment': 'department', 'Lowes_rack': 'rack'}
    return {key: json.loads((ROOT / 'stores' / STORE_ID / f'{name}.geojson').read_text(encoding='utf-8')) for key, name in files.items()}


def test_order_picking_routes_picks_and_persists():
    sample = json.loads((ROOT / 'frontend/data/orders' / f'{STORE_ID}.json').read_text(encoding='utf-8'))

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
    ready = "inventory.model && inventory.racks.size > 0 && picking.store && picking.network"

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

            # Existing Rack Inventory tab is untouched and still the default.
            assert await page.locator('#inventory-tab').is_visible()
            assert await page.locator('#inventory-table-body tr').count() == 100
            assert await page.evaluate("state.map.getLayoutProperty('picking-route-line', 'visibility')") == 'none'
            await page.locator('#ops-tab-picking').click()
            assert await page.locator('#picking-tab').is_visible() and await page.locator('#inventory-tab').is_hidden()
            # Staff screen: no Create Order / Reset Orders buttons; orders arrive on their own.
            assert await page.locator('#picking-generate').count() == 0 and await page.locator('#picking-reset').count() == 0
            assert await page.evaluate("picking.feedTimer !== null")
            await page.evaluate("picking.feedStopped = true; stopOrderFeedTimer()")  # deterministic from here on

            # 3/4/5. Fifteen orders, three carts, Cart 01 batches several orders.
            assert await page.evaluate("picking.store.orders.length") == 15
            assert await page.locator('#picking-order-body tr').count() == 15
            assert await page.locator('.picking-cart-card').count() == 3
            assert await page.evaluate("picking.store.cart('CART-01').orders.length") == 3

            # 6. Every order line points at an existing linked rack and inventory SKU.
            missing = await page.evaluate("""() => picking.store.orders.flatMap(o => o.lines).filter(l =>
                !inventory.racks.has(l.rack_id) || !inventory.model.get(l.rack_id).products.some(p => p.sku === l.sku)).length""")
            assert missing == 0

            # 8. Selected cart's route: one stop per rack, starts/ends at Pack & Dispatch, exact (best) order up to IndoorRouting.EXACT_STOP_LIMIT stops.
            plan = await page.evaluate("""() => { const p = planFor('CART-01'); const racks = new Set(picking.store.stops('CART-01').map(s => s.rack_id));
                return { order: p.order, racks: [...racks], method: p.method, distance: p.distance, unreachable: p.unreachable, legs: p.coords.length }; }""")
            assert sorted(plan['order']) == sorted(plan['racks']) and len(plan['order']) == len(set(plan['order']))
            assert plan['unreachable'] == [] and plan['distance'] > 0
            assert plan['method'] == ('exact' if len(plan['order']) <= await page.evaluate('IndoorRouting.EXACT_STOP_LIMIT') else 'heuristic')
            assert await page.locator('.picking-marker.current').count() == 1
            assert await page.locator('.picking-marker.end').count() == 1
            assert await page.locator('.picking-marker.end').inner_text() == 'D'
            assert await page.evaluate("picking.network.dispatch.name") == 'Pack & Dispatch'
            assert await page.evaluate("planFor('CART-01').start === picking.network.dispatch.cell")
            assert await page.evaluate("state.map.getSource('picking-routes')._data.features.every(f => f.properties.cart_id === 'CART-01')")

            # 7. Routes never pass through a rack (sampled along every leg of every cart).
            inside = await page.evaluate("""() => { """ + IN_RING + """
                const racks = [...inventory.racks.values()];
                let bad = 0;
                for (const cart of picking.store.carts) for (const line of planFor(cart.cart_id).coords) for (let i = 1; i < line.length; i++) {
                    const [x0, y0] = line[i - 1], [x1, y1] = line[i];
                    for (let t = 0; t <= 1; t += 0.05) {
                        const pt = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
                        if (racks.some(r => r.bounds.contains(pt) && inRing(pt, r.geometry.coordinates[0]))) bad++;
                    }
                }
                return bad; }""")
            assert inside == 0

            # Show-all toggle draws every active cart's route.
            await page.locator('#picking-show-all').check()
            carts_drawn = await page.evaluate("[...new Set(state.map.getSource('picking-routes')._data.features.map(f => f.properties.cart_id))].sort()")
            assert carts_drawn == ['CART-01', 'CART-02']
            await page.locator('#picking-show-all').uncheck()

            # 9/11. Picking deducts stock once, updates progress and moves the route on.
            first = plan['order'][0]
            line = await page.evaluate(f"""() => {{ const stop = picking.store.stops('CART-01').find(s => s.rack_id === '{first}');
                const e = stop.lines[0]; return {{ order: e.order_id, line_no: e.line.line_no, sku: e.line.sku, qty: e.line.quantity, rack: e.line.rack_id }}; }}""")
            stock = f"inventory.model.get('{line['rack']}').products.find(p => p.sku === '{line['sku']}').stock_quantity"
            before = await page.evaluate(stock)
            await page.locator('#picking-start').click()
            assert await page.evaluate("picking.store.cart('CART-01').started")
            await page.locator(f'.picking-line[data-line-key="{line["order"]}#{line["line_no"]}"] .picking-pick').click()
            assert await page.evaluate(stock) == before - line['qty']
            assert await page.locator(f'.picking-line[data-line-key="{line["order"]}#{line["line_no"]}"] .picking-picked').count() == 1
            assert await page.evaluate(f"picking.store.progress(picking.store.order('{line['order']}')).picked") == line['qty']
            assert await page.evaluate(f"picking.store.status(picking.store.order('{line['order']}'))") == 'Picking'
            assert await page.evaluate("picking.store.cart('CART-01').location") == line['rack']
            assert 'Last pick' in await page.locator('.picking-location').inner_text()
            # Picking the same line again is refused and does not deduct twice.
            again = await page.evaluate(f"picking.store.pickLine('{line['order']}', {line['line_no']}, inventory.model)")
            assert not again['ok'] and await page.evaluate(stock) == before - line['qty']
            # Undo restores the stock exactly once.
            await page.locator(f'.picking-line[data-line-key="{line["order"]}#{line["line_no"]}"] .picking-undo').click()
            assert await page.evaluate(stock) == before
            await page.locator(f'.picking-line[data-line-key="{line["order"]}#{line["line_no"]}"] .picking-pick').click()

            # 10. One rack serving several orders: separate lines and allocations per order.
            shared = await page.evaluate("""() => { picking.store.assign(picking.store.orders.filter(o => picking.store.status(o) === 'Pending').map(o => o.order_id), 'CART-03');
                return picking.store.stops('CART-03').filter(s => new Set(s.lines.map(e => e.order_id)).size > 1).map(s => ({ rack: s.rack_id, orders: s.lines.map(e => e.order_id) })); }""")
            assert shared, 'expected a rack shared by several orders on Cart 03'
            await page.locator('.picking-cart-card[data-cart-id="CART-03"]').click()
            rack = shared[0]['rack']
            entries = await page.evaluate(f"picking.store.stops('CART-03').find(s => s.rack_id === '{rack}').lines.map(e => [e.order_id, e.line.line_no])")
            await page.locator(f'.picking-line[data-line-key="{entries[0][0]}#{entries[0][1]}"] .picking-pick').click()
            other = await page.evaluate(f"picking.store.pick('{entries[1][0]}', {entries[1][1]})")
            assert other is None  # the other customer's line at the same rack is still open
            assert await page.evaluate(f"picking.store.stops('CART-03').find(s => s.rack_id === '{rack}').done") is False

            # An order cannot move to another cart once picking started on it.
            moved = await page.evaluate(f"picking.store.assign(['{line['order']}'], 'CART-02')")
            assert not moved['ok'] and await page.evaluate(f"picking.store.cartOf('{line['order']}').cart_id") == 'CART-01'

            # 11. Insufficient stock blocks the pick and never goes negative.
            short = await page.evaluate(f"""() => {{ const e = picking.store.stops('CART-03').find(s => s.rack_id === '{rack}').lines[1];
                const rec = inventory.model.get(e.line.rack_id); const prod = rec.products.find(p => p.sku === e.line.sku);
                inventory.model.changeStock(e.line.rack_id, e.line.sku, -prod.stock_quantity);
                refreshAfterEdit();
                return {{ key: e.key, sku: e.line.sku, rack: e.line.rack_id }}; }}""")
            await page.wait_for_timeout(100)
            assert await page.locator(f'.picking-line[data-line-key="{short["key"]}"] .picking-short').count() == 1
            assert await page.locator(f'.picking-line[data-line-key="{short["key"]}"] .picking-pick').is_disabled()
            order_id, line_no = short['key'].split('#')
            refused = await page.evaluate(f"picking.store.pickLine('{order_id}', {line_no}, inventory.model)")
            assert not refused['ok'] and 'Insufficient' in refused['message']
            assert await page.evaluate(f"inventory.model.get('{short['rack']}').products.find(p => p.sku === '{short['sku']}').stock_quantity") == 0

            # 13. An order completes only when all of its items are picked.
            await page.locator('.picking-cart-card[data-cart-id="CART-01"]').click()
            target = await page.evaluate("picking.store.cart('CART-01').orders[2]")
            assert not (await page.evaluate(f"picking.store.complete('{target}')"))['ok']
            lines = await page.evaluate(f"picking.store.order('{target}').lines.map(l => l.line_no)")
            for no in lines:
                if not await page.evaluate(f"picking.store.pick('{target}', {no})"):
                    result = await page.evaluate(f"(() => {{ const r = picking.store.pickLine('{target}', {no}, inventory.model); refreshAfterEdit(); refreshPicking(); return r; }})()")
                    assert result['ok'], result
            # Picked -> packed at Pack & Dispatch -> handed to the delivery driver.
            assert await page.evaluate(f"picking.store.status(picking.store.order('{target}'))") == 'Picked'
            await page.locator(f'.picking-cart-order[data-order-id="{target}"] .picking-complete').click()
            assert await page.evaluate(f"picking.store.status(picking.store.order('{target}'))") == 'Packed'
            assert await page.evaluate(f"picking.store.cartOf('{target}')") is None
            assert await page.evaluate("picking.store.stats().packed") == 1
            assert await page.locator('#picking-dispatch-all').is_enabled()
            await page.locator('#picking-dispatch-all').click()
            assert await page.evaluate(f"picking.store.status(picking.store.order('{target}'))") == 'Dispatched'
            assert await page.evaluate("[picking.store.stats().packed, picking.store.stats().dispatched]") == [0, 1]
            assert not await page.locator('#picking-dispatch-all').is_enabled()

            # Mark Item Picked follows the route, and the route re-plans on its own (no manual button).
            remaining = await page.evaluate("planFor('CART-01').order.length")
            await page.locator('#picking-pick-next').click()
            assert await page.evaluate("planFor('CART-01').order.length") <= remaining
            assert await page.locator('#picking-recalculate').count() == 0

            # An incoming online order lands in the queue as Pending with real rack locations, marked New.
            new_id = await page.evaluate("receiveOnlineOrder()")
            assert new_id == 'ORD-1016'
            assert await page.evaluate(f"picking.store.status(picking.store.order('{new_id}'))") == 'Pending'
            assert await page.locator(f'#picking-order-body tr[data-order-id="{new_id}"].is-new').count() == 1

            # 12. Refresh keeps orders, carts and picks.
            snapshot = await page.evaluate("JSON.stringify([picking.store.state.picks, picking.store.state.carts, picking.store.orders.length])")
            await page.reload()
            await page.wait_for_function(ready)
            assert await page.evaluate("JSON.stringify([picking.store.state.picks, picking.store.state.carts, picking.store.orders.length])") == snapshot
            assert await page.locator('#picking-tab').is_visible()

            # 14. Reset (testing aid, ?reset=1) restores the sample orders and returns picked stock.
            await page.evaluate("resetPickingData()")
            await page.wait_for_function("Object.keys(picking.store.state.picks).length === 0")
            assert await page.evaluate("picking.store.orders.length") == 15
            assert await page.evaluate("picking.store.carts.map(c => c.orders)") == [c['orders'] for c in sample['carts']]
            assert await page.evaluate(stock) == before
            await page.locator('#inventory-reset-all').evaluate('b => b.click()')  # also clears the manual zero-stock edit

            # 15. Existing controls still work.
            await page.locator('#ops-tab-inventory').click()
            assert await page.evaluate("state.map.getLayoutProperty('picking-route-line', 'visibility')") == 'none'
            await page.locator('#layer-department').uncheck()
            assert not await page.evaluate("isLayerVisible('departments')")
            await page.locator('#layer-department').check()
            await page.locator('#layer-inventory').uncheck()
            assert await page.evaluate("state.map.getLayoutProperty('inventory-rack-fill', 'visibility')") == 'none'
            await page.locator('#layer-inventory').check()
            await page.locator('#inventory-search').fill('R-0001')
            assert await page.locator('.inventory-result').count() >= 1
            assert errors == []
            await browser.close()

    try:
        asyncio.run(verify())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

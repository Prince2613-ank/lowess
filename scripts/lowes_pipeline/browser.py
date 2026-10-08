"""Rate-limited browser navigation and content-based network capture."""
import asyncio
import hashlib
import json
import re
import time
from urllib.parse import urlparse
from .geojson import collections, validate


class AccessDenied(RuntimeError):
    pass


class Browser:
    def __init__(self, context, catalog, args):
        self.context, self.catalog, self.args = context, catalog, args
        self.lock = asyncio.Lock()
        self.next_request = 0

    async def pace(self):
        async with self.lock:
            await asyncio.sleep(max(0, self.next_request - time.monotonic()))
            self.next_request = time.monotonic() + self.args.delay

    async def navigate(self, page, url):
        for attempt in range(self.args.retries + 1):
            await self.pace()
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=self.args.timeout * 1000)
                if response and response.status in (401, 403):
                    raise AccessDenied(f"HTTP {response.status}: {url}")
                if response and response.status >= 400:
                    raise RuntimeError(f"HTTP {response.status}: {url}")
                body = await page.locator("body").inner_text(timeout=self.args.timeout * 1000)
                if re.search(r"^\s*(Access Denied|Verify you are human|Pardon Our Interruption)", body, re.I):
                    raise AccessDenied(f"Website access challenge: {url}")
                return await page.content()
            except AccessDenied:
                raise
            except Exception:
                if attempt == self.args.retries:
                    raise
                await asyncio.sleep(min(30, 2 ** (attempt + 1)))

    async def html(self, url):
        cached = self.catalog.cached(url, self.args.cache_hours * 3600)
        if cached is not None and not self.args.refresh_discovery:
            return cached
        page = await self.context.new_page()
        try:
            html = await self.navigate(page, url)
            if "/Lowes-Stores" in url:
                # Multi-store cities can be accordions rather than links.
                for control in await page.get_by_text(re.compile(r"^[^\n]+\(\d+\s+Stores?\)$", re.I)).all():
                    if await control.is_visible() and await control.get_attribute("aria-expanded") != "true":
                        await control.click(timeout=self.args.timeout * 1000)
                html = await page.content()
            self.catalog.cache(url, html)
            return html
        finally:
            await page.close()

    async def capture(self, store):
        page = await self.context.new_page()
        captured, errors, tasks = [], [], set()
        host = urlparse(store["store_url"]).netloc

        async def inspect(response):
            try:
                url = response.url
                # Page is store-scoped. Explicit IDs in map paths must match.
                match = re.search(r"/store/(\d+)/", url)
                if match and match[1] != store["store_id"]:
                    return
                if response.status != 200:
                    return
                content_type = response.headers.get("content-type", "").lower()
                resource = response.request.resource_type
                if not (resource in ("xhr", "fetch") or "json" in content_type or re.search(r"map|geojson|floor", url, re.I)):
                    return
                body = await response.body()
                try:
                    value = json.loads(body)
                except (ValueError, UnicodeError):
                    return
                if not list(collections(value)):
                    return
                # Avoid collecting unrelated geographic responses (e.g. a locator).
                names = " ".join(name for name, _ in collections(value))
                property_names = " ".join(str(f.get("properties", {})) for _, fc in collections(value) for f in fc.get("features", [])[:3])
                if not re.search(r"department|depertment|aisle|rack|floor|map-view|indoor", url + names + property_names, re.I):
                    return
                validate(value)
                digest = hashlib.sha256(body).hexdigest()
                if not any(c["sha256"] == digest for c in captured):
                    captured.append({"url": url, "content_type": content_type, "sha256": digest, "body": body, "data": value})
                    print(f"[NETWORK] Store {store['store_id']}: map response detected", flush=True)
            except Exception as exc:
                errors.append(str(exc))

        def listener(response):
            task = asyncio.create_task(inspect(response))
            tasks.add(task)
            task.add_done_callback(tasks.discard)

        page.on("response", listener)
        try:
            html = await self.navigate(page, store["store_url"])
            self.catalog.cache(store["store_url"], html)
            control = page.get_by_text(re.compile(r"^Store\s+Map$", re.I))
            opened = False
            for element in await control.all():
                if await element.is_visible():
                    print(f"[MAP] Opening store map {store['store_id']}", flush=True)
                    await element.click(timeout=self.args.timeout * 1000)
                    opened = True
                    break
            # Wait for map responses even when the page loaded them eagerly.
            deadline = time.monotonic() + (self.args.map_wait if opened else min(3, self.args.map_wait))
            while time.monotonic() < deadline:
                await asyncio.sleep(0.5)
            if tasks:
                await asyncio.gather(*list(tasks), return_exceptions=True)
            if not captured:
                # Endpoint family evidenced by the reference network response;
                # ID always comes from the current discovered store URL.
                endpoint = f"{urlparse(store['store_url']).scheme}://{host}/omniselling/store/{store['store_id']}/map-view"
                await self.pace()
                result = await self.context.request.get(endpoint, timeout=self.args.timeout * 1000)
                if result.status in (401, 403):
                    raise AccessDenied(f"HTTP {result.status}: store map {store['store_id']}")
                if result.ok:
                    body = await result.body()
                    value = json.loads(body)
                    validate(value)
                    captured.append({"url": endpoint, "content_type": result.headers.get("content-type", ""), "sha256": hashlib.sha256(body).hexdigest(), "body": body, "data": value})
                    print(f"[NETWORK] Store {store['store_id']}: map API response detected", flush=True)
                elif result.status in (404, 204) and not opened:
                    return [], "no_map", "Store map unavailable (no control and map API returned no map)"
            if captured:
                return captured, "downloaded", None
            return [], "failed", "; ".join(errors) or "No map GeoJSON detected"
        finally:
            page.remove_listener("response", listener)
            if tasks:
                await asyncio.gather(*list(tasks), return_exceptions=True)
            await page.close()

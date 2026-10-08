"""Single-command nationwide pipeline. The legacy calibration catalog stays intact."""
import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright
from . import discovery
from .browser import Browser, AccessDenied
from .catalog import Catalog, write_json, now
from .geojson import validate

ROOT = Path(__file__).resolve().parents[2]


def arguments():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base-url", default=os.getenv("LOWES_BASE_URL", "https://www.lowes.com"))
    p.add_argument("--output", type=Path, default=Path(os.getenv("LOWES_OUTPUT", ROOT / "data")))
    p.add_argument("--workers", type=int, default=int(os.getenv("LOWES_WORKERS", "2")))
    p.add_argument("--delay", type=float, default=float(os.getenv("LOWES_DELAY", "2")))
    p.add_argument("--timeout", type=float, default=float(os.getenv("LOWES_TIMEOUT", "30")))
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--map-wait", type=float, default=8)
    p.add_argument("--cache-hours", type=float, default=24)
    p.add_argument("--channel", default=os.getenv("LOWES_BROWSER", "chrome"), help="Installed chrome/msedge, or chromium")
    p.add_argument("--headed", action="store_true", default=os.getenv("LOWES_HEADLESS", "true").lower() == "false")
    p.add_argument("--force", action="store_true")
    p.add_argument("--refresh-discovery", action="store_true")
    p.add_argument("--states", default=os.getenv("LOWES_STATES", ""), help="Optional comma-separated filter; default discovers all")
    p.add_argument("--store-ids", default="", help="Optional verification/download subset")
    p.add_argument("--limit", type=int, default=0, help="Optional map-download limit; 0 means all")
    args = p.parse_args()
    if args.workers < 1 or args.workers > 8 or args.delay < 0.5 or args.timeout <= 0 or args.retries < 0 or args.map_wait < 0 or args.limit < 0:
        p.error("workers must be 1–8, delay >=0.5, timeout >0, retries/map-wait/limit >=0")
    return args


def seed_legacy(catalog):
    """Import calibrated local data only for the existing single-store project."""
    legacy_path = ROOT / "data" / "stores.json"
    if not legacy_path.exists():
        return
    legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
    for store in legacy:
        if catalog.get(store["store_id"]):
            continue
        match = re.search(r",\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)", store["address"])
        if not match:
            continue
        city, region, zipcode = match.groups()
        entry = {**store, "city": city, "state": region, "zip": zipcode, "map_status": "pending", "source": "existing_project", "store_url": None}
        if len(legacy) == 1:
            layers = {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in ROOT.glob("Lowes_*.geojson")}
            if layers:
                validate(layers)
                relative = f"stores/{region}/{store['store_id']}/map.geojson"
                write_json(catalog.root / relative, layers)
                entry.update(map_status="imported", map_file=relative, map_source="Existing calibrated GeoJSON layers", error=None)
        catalog.put(entry)
    catalog.export()


async def discover(browser, catalog, args, report):
    url = args.base_url.rstrip("/") + "/Lowes-Stores"
    regions = discovery.states(await browser.html(url), url)
    if not regions:
        raise RuntimeError("No state links discovered; directory may have changed")
    write_json(catalog.root / "states.json", {"updated": now(), "states": regions})
    report["states_discovered"] = len(regions)
    filters = {x.strip().upper() for x in args.states.split(",") if x.strip()}
    all_cities, urls = [], set()
    sem = asyncio.Semaphore(args.workers)

    async def city_job(city):
        async with sem:
            try:
                if discovery.STORE.match(urlparse(city["url"]).path):
                    found = [city["url"]]
                else:
                    html = await browser.html(city["url"])
                    found = discovery.store_urls(html, city["url"])
                if not found:
                    raise RuntimeError("No store links on city page")
                urls.update(found)
                city["status"] = "discovered"
            except Exception as exc:
                city.update(status="failed", error=str(exc))
                catalog.failure(city["url"], "city", exc)
                report["discovery_failures"] += 1

    for region in regions:
        if filters and region["state"] not in filters:
            continue
        try:
            found = discovery.cities(await browser.html(region["url"]), region["url"], region["state"])
            if not found:
                raise RuntimeError("No city/store links discovered")
            print(f"[DISCOVER] {region['name']}: {len(found)} city/store links", flush=True)
            all_cities.extend(found)
            await asyncio.gather(*(city_job(c) for c in found))
            write_json(catalog.root / "cities.json", {"updated": now(), "cities": all_cities})
        except Exception as exc:
            catalog.failure(region["url"], "state", exc)
            report["discovery_failures"] += 1
            print(f"[ERROR] {region['name']}: {exc}", flush=True)
    report["cities_discovered"] = len({(c["state"], c["name"].casefold()) for c in all_cities})
    report["stores_discovered"] = len(urls)

    async def store_job(url):
        async with sem:
            try:
                entry = discovery.metadata(await browser.html(url), url)
                entry["metadata_error"] = None if entry["address"] and entry["latitude"] is not None else "Address or coordinates missing from official page"
                catalog.put(entry)
                print(f"[STORE] {entry['state']} {entry['name']} - {entry['store_id']}", flush=True)
            except Exception as exc:
                entry = discovery.metadata("", url)
                previous = catalog.get(entry["store_id"]) or {}
                catalog.put({**entry, **previous, "store_url": url, "metadata_error": str(exc)})
                catalog.failure(url, "store", exc)
                report["discovery_failures"] += 1
            catalog.export()
    await asyncio.gather(*(store_job(url) for url in sorted(urls)))


async def download(browser, catalog, args, report):
    filters = {x.strip().upper() for x in args.states.split(",") if x.strip()}
    ids = {x.strip() for x in args.store_ids.split(",") if x.strip()}
    entries = [e for e in catalog.entries() if (not filters or e.get("state") in filters) and (not ids or e["store_id"] in ids)]
    if args.limit:
        entries = entries[:args.limit]
    sem = asyncio.Semaphore(args.workers)

    async def job(entry):
        async with sem:
            relative = f"stores/{entry['state']}/{entry['store_id']}/map.geojson"
            path = catalog.root / relative
            if not args.force and path.exists():
                try:
                    validate(json.loads(path.read_text(encoding="utf-8")))
                    report["maps_skipped"] += 1
                    catalog.put({**entry, "map_file": relative, "map_status": "imported" if entry.get("map_status") == "imported" else "downloaded", "error": None})
                    print(f"[SKIP] Store {entry['store_id']} - valid map already exists", flush=True)
                    return
                except (ValueError, OSError):
                    pass
            try:
                if not entry.get("store_url"):
                    raise RuntimeError("Store URL not yet discovered")
                for attempt in range(args.retries + 1):
                    try:
                        captures, status, error = await browser.capture(entry)
                        if status != "failed" or attempt == args.retries:
                            break
                    except AccessDenied:
                        raise
                    except Exception:
                        if attempt == args.retries:
                            raise
                    await asyncio.sleep(min(30, 2 ** (attempt + 1)))
                if captures:
                    value = captures[0]["data"] if len(captures) == 1 else {"responses": [{"url": c["url"], "data": c["data"]} for c in captures]}
                    counts = validate(value)
                    write_json(path, value)
                    for c in captures:
                        raw_path = path.parent / "responses" / (c["sha256"] + ".json")
                        raw_path.parent.mkdir(exist_ok=True)
                        raw_path.write_bytes(c["body"])
                    write_json(path.parent / "provenance.json", {"store_id": entry["store_id"], "captured_at": now(), "layers": counts, "responses": [{k: v for k, v in c.items() if k not in ("data", "body")} for c in captures]})
                    entry.update(map_file=relative, map_source="official_network_response", layer_counts=counts)
                    print(f"[SAVE] {path}", flush=True)
                entry.update(map_status=status, error=error)
                report[{"downloaded": "maps_downloaded", "failed": "maps_failed", "no_map": "no_map_available"}[status]] += 1
            except Exception as exc:
                # Preserve a previous usable map on failed force refresh.
                entry.update(map_status="failed", error=str(exc))
                report["maps_failed"] += 1
                print(f"[ERROR] Store {entry['store_id']}: {exc}", flush=True)
            catalog.put(entry)
            catalog.export()
    await asyncio.gather(*(job(entry) for entry in entries))


async def run(args, mode="all"):
    catalog = Catalog(args.output)
    report = {"started": now(), "mode": mode, "states_discovered": 0, "cities_discovered": 0, "stores_discovered": 0,
              "maps_downloaded": 0, "maps_skipped": 0, "maps_failed": 0, "no_map_available": 0, "discovery_failures": 0}
    try:
        seed_legacy(catalog)
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=not args.headed, channel=None if args.channel == "chromium" else args.channel)
            context = await browser.new_context()
            network = Browser(context, catalog, args)
            try:
                if mode != "download":
                    try:
                        await discover(network, catalog, args, report)
                    except Exception as exc:
                        report["discovery_failures"] += 1
                        report["discovery_error"] = str(exc)
                        catalog.failure(args.base_url + "/Lowes-Stores", "directory", exc)
                        print(f"[ERROR] Directory: {exc}", flush=True)
                if mode != "discover":
                    await download(network, catalog, args, report)
            finally:
                await browser.close()
    except Exception as exc:
        report["fatal_error"] = str(exc)
        print(f"[ERROR] {exc}", flush=True)
    finally:
        catalog.export()
        report.update(finished=now(), catalog_stores=len(catalog.entries()))
        write_json(catalog.root / "pipeline-report.json", report)
        catalog.close()
    print("\nLOWE'S NATIONWIDE STORE MAP PIPELINE\n" + json.dumps(report, indent=2), flush=True)
    return 1 if report.get("fatal_error") or report["maps_failed"] or report["discovery_failures"] else 0


def main(mode="all"):
    return asyncio.run(run(arguments(), mode))

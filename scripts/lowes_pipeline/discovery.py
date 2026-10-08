"""Parse official directory links and store metadata; no store/state lists."""
import json
import re
from urllib.parse import urljoin, urlparse, unquote
from bs4 import BeautifulSoup

STATE = re.compile(r"^/Lowes-Stores/([^/]+)/([A-Za-z]{2})/?$", re.I)
STORE = re.compile(r"^/store/([A-Za-z]{2})-([^/]+)/(\d+)/?$", re.I)


def links(html, base):
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    for a in soup.select("a[href]"):
        url = urljoin(base, a["href"]).split("#")[0].split("?")[0]
        if urlparse(url).netloc != urlparse(base).netloc or url in seen:
            continue
        seen.add(url)
        yield a.get_text(" ", strip=True), url


def states(html, base):
    result = []
    for text, url in links(html, base):
        m = STATE.match(urlparse(url).path)
        if m:
            result.append({"name": text or unquote(m[1]), "state": m[2].upper(), "url": url})
    return sorted(result, key=lambda x: x["name"])


def cities(html, base, region):
    result = []
    for text, url in links(html, base):
        path = urlparse(url).path
        m = STORE.match(path)
        # Some cities link directly to a store; others have a city directory.
        directory = path.lower().startswith(urlparse(base).path.rstrip("/").lower() + "/")
        if (m and m[1].upper() == region) or directory:
            name = unquote(m[2]).replace("-", " ") if m else unquote(path.rstrip("/").split("/")[-1]).replace("-", " ")
            result.append({"name": name if m else text or name, "state": region, "url": url})
    return result


def store_urls(html, base):
    urls = [url for _, url in links(html, base) if STORE.match(urlparse(url).path)]
    if STORE.match(urlparse(base).path):
        urls.insert(0, base)
    return list(dict.fromkeys(urls))


def walk(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk(v)


def metadata(html, url):
    m = STORE.match(urlparse(url).path)
    if not m:
        raise ValueError(f"Unrecognized store URL: {url}")
    state, city, store_id = m.groups()
    soup = BeautifulSoup(html, "html.parser")
    entry = {"store_id": store_id, "state": state.upper(), "city": unquote(city).replace("-", " "),
             "store_url": url, "name": "", "address": "", "zip": "", "latitude": None, "longitude": None}
    h1 = soup.find("h1")
    entry["name"] = h1.get_text(" ", strip=True) if h1 else f"Lowe's #{store_id}"
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            objects = list(walk(json.loads(script.string or script.get_text())))
        except (ValueError, TypeError):
            continue
        candidates = [o for o in objects if isinstance(o.get("address"), dict)
                      and re.search(r"Store|LocalBusiness", str(o.get("@type", "")), re.I)]
        for obj in candidates:
            addr = obj["address"]
            if addr.get("addressRegion", state).upper() != state.upper():
                continue
            obj_url = obj.get("url", "")
            if obj_url and STORE.match(urlparse(obj_url).path) and not obj_url.rstrip("/").endswith("/" + store_id):
                continue
            entry.update(name=obj.get("name") or entry["name"], city=addr.get("addressLocality") or entry["city"],
                         zip=str(addr.get("postalCode", "")), address=", ".join(str(addr[k]) for k in ("streetAddress", "addressLocality", "addressRegion", "postalCode") if addr.get(k)))
            geo = obj.get("geo") or {}
            try:
                lat, lon = float(geo["latitude"]), float(geo["longitude"])
                if -90 <= lat <= 90 and -180 <= lon <= 180:
                    entry.update(latitude=lat, longitude=lon)
            except (ValueError, KeyError, TypeError):
                pass
            return entry
    address = soup.find("address")
    if address:
        entry["address"] = address.get_text(" ", strip=True)
    # Microdata is a second official metadata representation.
    for key in ("latitude", "longitude"):
        element = soup.select_one(f'[itemprop="{key}"]')
        if element:
            try:
                value = float(element.get("content") or element.get_text())
                limit = 90 if key == "latitude" else 180
                if -limit <= value <= limit:
                    entry[key] = value
            except ValueError:
                pass
    return entry

# Lowe's Map System

> This folder is the Lowe's app only. **Menards** is a separate app in
> [`../menards/`](../menards/README.md). Run every command below from this
> `lowes/` folder. The shared virtual environment is at the repository root
> (`..\.venv`).

## Nationwide automated pipeline

Run from this `lowes/` folder (dependencies are installed in `..\.venv`):

```powershell
..\.venv\Scripts\python.exe scripts\run_pipeline.py
```

With the virtual environment activated, the equivalent command is
`python scripts/run_pipeline.py`. No DevTools, URL copying, or manual map files
are needed. Chrome is the default browser; `--channel msedge` uses Edge.
For a new installation, install `requirements.txt` first. If using
`--channel chromium`, also run `python -m playwright install chromium`.

The pipeline discovers the official State Directory, expands multi-store city
groups, follows city/store links, parses store IDs and JSON-LD metadata, opens
Store Map in Playwright, and inspects network response content. A dynamically
constructed per-store API request is used if the visible map flow yields no
data. That endpoint family comes from the supplied reference; IDs always come
from discovered store pages. Unrelated locator responses and responses naming
a different store ID are excluded. Complete JSON responses, including all
layers and metadata, are preserved. Separate responses are stored in a
`responses` envelope; byte-exact originals and SHA-256 provenance are retained.

### Commands and configuration

```powershell
python scripts/discover_all_lowes.py
python scripts/download_all_store_maps.py
python scripts/run_pipeline.py --force
python scripts/run_pipeline.py --workers 2 --delay 2
python scripts/run_pipeline.py --states AL,AZ --limit 5
python scripts/download_all_store_maps.py --store-ids 1665
```

The default scope is all directory states/territories. Optional filters only
restrict a run. `--force` refreshes maps; `--refresh-discovery` ignores the HTML
cache. Defaults: two workers, two seconds between navigations/API requests,
30-second timeout, two retries with exponential backoff, 24-hour HTML cache,
eight-second map response collection window. Use `--map-wait` for slower pages.
401/403 challenges are reported, not repeatedly retried. `--headed` is optional;
no manual browser interaction is part of the pipeline.

Environment equivalents: `LOWES_BASE_URL`, `LOWES_OUTPUT`, `LOWES_WORKERS`,
`LOWES_DELAY`, `LOWES_TIMEOUT`, `LOWES_BROWSER`, `LOWES_HEADLESS`, `LOWES_STATES`.
Use the same `LOWES_OUTPUT` for the server if changing the data directory.

### Data and compatibility

* `data/catalog.sqlite`: master catalog, cached pages, and discovery failures.
  SQLite commits after each store; frontend exports are replaced atomically.
* `data/stores-index.json`: generated nationwide frontend index.
* `data/states.json`, `data/cities.json`: successful directory discovery results.
* `data/stores/<state>/<store_id>/store.json`: store metadata and map status.
* `data/stores/<state>/<store_id>/map.geojson`: complete layered map response.
* `data/stores/<state>/<store_id>/responses/`: original network response bytes.
* `data/stores/<state>/<store_id>/provenance.json`: URLs, hashes, capture time,
  and validated layer counts.
* `data/pipeline-report.json`: actual counts and errors for the latest run.

The existing `data/stores.json`, layout/georeference files, and calibration
API remain compatible. The initial single-store calibrated GeoJSON is imported
into the new catalog as `imported`, not counted as a new download. The original
source files are unchanged. A valid existing map is skipped; a failed forced
refresh retains the prior map and records the refresh error. One failed store
does not stop other stores. Nonzero exit status indicates failures.

### Frontend

The existing FastAPI app serves the updated Leaflet directory. Start it with
`python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000`.
Search name, ID, state, city, ZIP, or address; state/city filters support multiple
stores in one city. Results render in pages of 100. Selecting a store centers
its actual coordinates and loads only that store's map through `/api/catalog`.
Five recently viewed maps are cached. A selection generation counter prevents
late responses from replacing a newer selection. Satellite, layer toggles,
labels, and point symbols reuse the existing renderer. Extra layers remain
available through a Leaflet control. Missing maps show the location and an
unavailable message. Source map coordinates far from the store are explicitly
flagged, with separate Location/Indoor view buttons; no assumed translation or
shared Bloomfield fallback is applied.

### Verification and current live limitation

`python -m pytest -q` runs legacy regression tests, parser/validator/catalog
tests, and a real Chrome integration against a local synthetic directory.
The integration tests two states, multiple stores in one city, complete map
capture, missing/malformed maps, resume, and forced refresh. Local fixture
results are not counted as downloaded Lowe's maps.

The live nationwide run on 2026-09-15 received HTTP 403 from Lowe's State
Directory in both direct HTTP and fresh Chrome. Consequently, nationwide live
discovery and multi-state real map extraction could not be verified. The
official Bloomfield (CT) and Alabaster (AL) store pages also returned HTTP 403
in separate browser extraction attempts. All 57 automated tests passed;
browser UI checks cover real saved Bloomfield rendering plus synthetic
store switching, filters, lazy loading, layer controls, missing/malformed
maps, escaped labels, and stale response rejection. Leaflet 1.9.4 is vendored
with its license, so UI initialization does not depend on a CDN.
The saved Bloomfield map remains usable. Rerunning the same command resumes when
the official site permits access; no fabricated stores or maps are inserted.

---

Associates an interactive Lowe's-style store floor layout (which lives in
its own **local coordinate system**) with the store's real-world
**latitude/longitude**, via a configurable transformation layer, and
renders the result as an interactive Leaflet map over OpenStreetMap tiles.

```
floor_x/floor_y  ->  local meters  ->  rotate + scale + translate  ->  latitude/longitude
```

The floor-plan coordinates are **never** treated as lat/lon. They are
converted to meters, rotated/scaled/translated per a per-store calibration,
and projected onto the globe around a geographic anchor point using an
azimuthal-equidistant (AEQD) projection centered on that anchor - which
preserves real-world distance and direction for an area the size of a
single store.

---

## Project layout

```
lowes-map-system/
    backend/
        main.py             FastAPI app, routes, startup validation
        models.py           Pydantic models (Store, Layout, Transform, Geometry,
                             BuildingFeatureCollection, ControlPoint, ...)
        store_service.py    Loads/validates data/stores.json
        layout_service.py   Loads layouts, builds cached geo-transformed GeoJSON
        transform.py        The floor -> local meters -> lat/lon pipeline (pyproj)
        georeference.py     Building-footprint alignment engine (auto align +
                             control-point similarity fit + alignment error)
        config.py           Paths + the store_id allow-list pattern
    data/
        stores.json         Store directory (id, address, lat/lon, layout_id,
                             building_id, georeference summary)
        layouts/
            1665.json        Local-coordinate floor layout for store #1665
        buildings/
            1665.geojson     Real building footprint (OpenStreetMap) for #1665
        georeference/
            1665.json        Floor<->geo control points for #1665
    frontend/
        index.html          Leaflet map + store selector + layer panel +
                             calibration panel + control-point editor
        app.js               Rendering, zoom-based level-of-detail, calibration,
                              building overlay, auto-align, control points
        styles.css           Lowe's-style department/label/marker styling
    scripts/
        validate_layout.py   Validate layouts, buildings, and georeference files
        convert_layout.py    Dump a store's layout as standalone GeoJSON files
    tests/
        test_transform.py           Floor <-> geographic transform pipeline
        test_georeference.py        Building-alignment engine
        test_models_validation.py   Pydantic validation (GeoJSON, stores, ...)
        test_api.py                 End-to-end API tests (FastAPI TestClient)
    requirements.txt
    README.md
```

---

## Setup

The virtual environment lives at the repository root and is shared with the
Menards app.

```bash
# from the repository root
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux/macOS
source .venv/bin/activate

pip install -r lowes/requirements.txt
```

## Run

```bash
cd lowes
uvicorn backend.main:app --reload
```

Then open **http://127.0.0.1:8000** - the FastAPI app serves the API under
`/api/...` and the static frontend at `/`.

On startup, the backend validates every store in `data/stores.json` and
every layout file in `data/layouts/` (schema, lat/lon ranges, NaN/Inf
coordinates, cross-references between stores and layouts) and refuses to
start if anything is invalid.

---

## Example store (#1665)

```json
{
    "store_id": "1665",
    "name": "Lowe's Bloomfield",
    "address": "325 Cottage Grove Road, Bloomfield, CT 06002",
    "latitude": 41.8140843218019,
    "longitude": -72.71526758866406,
    "layout_id": "1665"
}
```

The bundled layout (`data/layouts/1665.json`) models a simplified big-box
floor plan (Lumber, Building Materials, Garden Center, Appliances, Tools,
Hardware, Electrical, Plumbing, Paint, Flooring, Home Decor, Front
End/Checkouts) with aisles, racks, and both basic-information markers
(entrance/exit, restrooms, checkouts, returns, customer service, pro
service desk, store pickup, pickup lockers) and store-service markers (key
copying, millwork desk, wood/wire/carpet/glass/chain-rope cutting, blind
cutting, flooring desk, appliance desk, home decor desk, kitchen design
desk). Floor-plan units are **feet**; `transform.scale = 0.3048` converts
them to meters.

---

## The transformation engine (`backend/transform.py`)

```python
floor_to_local(x, y, transform)              # step 1-2: scale floor units -> meters
apply_rotation_and_offset(x, y, transform)    # step 3-4: rotate about origin, translate
local_to_latlon(east_m, north_m, anchor)      # step 5: AEQD meters -> WGS84 lat/lon
floor_to_latlon(x, y, transform, anchor)      # full pipeline, floor (x,y) -> (lat, lon)
geometry_to_geojson(geometry, transform, anchor)  # whole GeoJSON geometry -> geographic GeoJSON
```

Internally, `local_to_latlon` uses a `pyproj.Transformer` built from an
azimuthal-equidistant CRS centered on the store's anchor
(`+proj=aeqd +lat_0=... +lon_0=... +datum=WGS84 +units=m`), inverted to
WGS84. This is a proper geodetic projection (not "add x to latitude"),
verified to reproduce real-world distances to millimeter precision for
store-sized layouts (a 100 ft/30.48 m department wall in the bundled
layout comes back as exactly 30.48 m of real-world geodesic distance).

Per-store calibration lives in each layout file:

```json
{
    "anchor": { "latitude": 41.8140843218019, "longitude": -72.71526758866406 },
    "transform": {
        "scale": 0.3048,
        "rotation_degrees": 0.0,
        "offset_x": 0.0,
        "offset_y": 0.0
    }
}
```

Supported geometry types (all converted coordinate-by-coordinate through
the pipeline above): `Point`, `LineString`, `MultiLineString`, `Polygon`,
`MultiPolygon`.

---

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/stores` | List all stores |
| GET | `/api/stores/{store_id}` | One store's directory info |
| GET | `/api/stores/{store_id}/layout` | Geographic (lat/lon) GeoJSON layout |
| GET | `/api/stores/{store_id}/layout/raw` | Original local-coordinate layout |
| GET | `/api/stores/{store_id}/map` | `{store, anchor, layout}` combined view |
| POST | `/api/stores/{store_id}/calibrate` | Save new anchor/transform values |
| GET | `/api/stores/{store_id}/building` | Real building-footprint GeoJSON |
| GET | `/api/stores/{store_id}/georeference` | Saved control points |
| POST | `/api/stores/{store_id}/georeference` | Save control points (returns a fitted transform if >=2 points) |
| POST | `/api/stores/{store_id}/auto-align` | Compute (not save) a building-footprint alignment |
| GET | `/api/stores/{store_id}/alignment-report` | Alignment quality of the currently saved calibration |

### Example requests

```bash
curl http://127.0.0.1:8000/api/stores

curl http://127.0.0.1:8000/api/stores/1665

curl http://127.0.0.1:8000/api/stores/1665/layout/raw

curl http://127.0.0.1:8000/api/stores/1665/layout

curl http://127.0.0.1:8000/api/stores/1665/map

curl -X POST http://127.0.0.1:8000/api/stores/1665/calibrate \
  -H "Content-Type: application/json" \
  -d '{
        "anchor_latitude": 41.8140843218019,
        "anchor_longitude": -72.71526758866406,
        "scale": 0.3048,
        "rotation_degrees": 3.5,
        "offset_x": 1.2,
        "offset_y": -0.6
      }'
```

`/api/stores/{store_id}/layout` and `/map` responses are cached in memory
per store_id (`@lru_cache` in `layout_service.py`) so the coordinate
transform only runs once per process lifetime per store; saving a
calibration invalidates the cache for that store.

---

## Building-footprint georeferencing (`backend/georeference.py`)

A center-point-only anchor is not enough to place a floor plan accurately
over a real building - it fixes one point but says nothing about the
building's true size, aspect ratio, or orientation. This system additionally
aligns the floor plan against the store's **real building footprint**:

```
data/buildings/{store_id}.geojson       real building footprint (WGS84 polygon)
data/georeference/{store_id}.json       floor<->geo control points
```

`data/buildings/1665.geojson` is the actual OpenStreetMap building for Lowe's
\#1665 (way `146204404`, tagged `ref=1665`, `brand=Lowe's`), fetched from the
OSM API - not a synthesized rectangle. Its `metadata` block records the exact
source (`osm_way_id`, retrieval date, ODbL license).

**Auto align** (`POST /api/stores/{id}/auto-align`):

1. `calculate_building_bounds()` projects the building polygon into local
   AEQD meters around the store anchor and takes its minimum rotated
   bounding rectangle (shapely) - giving a real width/height/rotation.
2. `calculate_floor_bounds()` takes the floor plan's own bounding box.
3. `calculate_initial_transform()` matches the two boxes: it tries both axis
   correspondences (the floor's width could align with the building's long
   or short axis) and sweeps scale, scoring each candidate by IoU against
   the *real building polygon* (not just its bounding box).
4. `optimize_transform()` refines (rotation, scale_x, scale_y, offset_x,
   offset_y) by coordinate-descent, maximizing that same IoU.
5. `calculate_alignment_error()` reports how good the result actually is
   (mean distance from the floor plan's transformed corners to the real
   building outline, plus IoU, areas, and the fitted parameters) - the
   fit is a best-effort starting point, not a guarantee.

For store #1665 this converges to **IoU 0.83, alignment error ~5.2 m** - not
a perfect match, because the real building has an attached garden-center/
canopy structure the simplified rectangular floor plan doesn't model
separately. Non-uniform `scale_x`/`scale_y` (see `Transform` in
`backend/models.py`) is what lets the fit absorb the floor plan's aspect
ratio not matching the building's exactly, rather than distorting rotation
to compensate.

**Manual control points**: `POST /api/stores/{id}/georeference` accepts
named floor<->geo point correspondences (e.g. the floor plan's four
corners, each with a real-world lat/lon looked up from satellite imagery).
With >=2 points, `fit_similarity_from_control_points()` solves a closed-form
2D similarity least-squares fit (via complex-number linear algebra - the
standard Procrustes/Umeyama solution without reflection) and returns it
alongside the saved points, so the calibration UI can preview and apply it.

Both paths only ever *compute and return* a transform - saving it into the
authoritative `data/layouts/{store_id}.json` still goes through the existing
validated `POST /api/stores/{id}/calibrate`. If no building footprint is on
file, `/auto-align`, `/building`, and `/alignment-report` all return
`{"status": "needs_calibration", ...}` rather than inventing coordinates.

---

## Frontend

Plain Leaflet.js + vanilla JS (`frontend/app.js`), OpenStreetMap tiles
(no paid basemap API). The map:

- Initially centers on the store #1665 anchor (41.8140843218019,
  -72.71526758866406) and loads its layout automatically.
- Renders department polygons in the Lowe's palette
  (`stroke #BCDDF4`, `fill #9BCBEB`, `fill-opacity 0.20`).
- Renders aisle lines, rack polygons, and category-colored marker icons
  for every basic-information and store-service marker type.
- Supports zoom in/out via the Leaflet +/- control, mouse wheel, drag/pan,
  and touch zoom; clicking a department, aisle, rack, or marker opens a
  popup.
- Applies zoom-based level of detail (see below) - **every** department/
  marker at a qualifying zoom is rendered individually; there is no
  "+N more" clustering placeholder at any zoom level.
- Provides a store selector in the top bar; selecting a store re-centers
  the map on its anchor and (re)loads its layout.
- Provides a **Calibrate** mode: adjust scale / rotation / X offset / Y
  offset with `[-] value [+]` controls, see the floor layout move live
  over the real basemap, then **Save Calibration** to persist the new
  transform to `data/layouts/{store_id}.json` via the `/calibrate` API.

### Zoom behavior

| Zoom | Behavior |
|---|---|
| 18 | Store-level layout (department outlines only) |
| 19 | Department labels appear |
| 20 | Every department label individually visible (no clustering text) |
| 21 | Aisle geometry + aisle labels visible |
| 22 | Rack geometry + rack info visible |
| 23 | Maximum floor-layout detail |

Basic-information and store-service markers each carry their own
`min_zoom` in the layout data (entrance/exit and checkouts appear earliest,
at zoom 18-19; service desks like key copying/wood cutting appear at
zoom 20+).

---

## Calibration workflow

1. Select a store from the top-bar dropdown - its floor layout loads and
   is drawn over the real map using the transform already stored in
   `data/layouts/{store_id}.json`.
2. Click **Calibrate**. The app fetches the raw (local-coordinate) layout
   and switches to a live preview layer.
3. Use the Scale / Rotation / X offset / Y offset `[-] [+]` controls -
   the preview layer redraws immediately (client-side approximation) so
   you can see the floor plan slide/rotate/scale over the basemap.
4. Click **Save Calibration**. This posts the new anchor + transform
   values to `POST /api/stores/{store_id}/calibrate`, which re-validates
   and writes them into the store's layout JSON, invalidates the server's
   cached geo layout, and the app reloads the store using the
   authoritative (pyproj/AEQD) transform.

Calibration preview math (client-side, `frontend/app.js`) is a flat-earth
approximation used only for interactive feedback while dragging controls.
The value actually saved and subsequently rendered always goes through the
authoritative AEQD pipeline in `backend/transform.py`.

---

## Scripts

```bash
# Validate every layout file (or one store_id) against the Pydantic models
python scripts/validate_layout.py
python scripts/validate_layout.py 1665

# Dump a store's geo-transformed layout as standalone .geojson files
# (e.g. to inspect in QGIS or geojson.io)
python scripts/convert_layout.py 1665 --out converted/
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest tests/
```

Covers the floor<->geographic transform pipeline (including its inverse),
rotation/scale/translation in isolation, the building-alignment engine
(bounding-box comparison, auto-align IoU optimization, alignment error,
four-point control-point fitting), Pydantic validation (invalid GeoJSON,
NaN/Inf, out-of-range lat/lon, path traversal), and every API endpoint
end-to-end (including calibration and georeference save/load round-trips).

---

## Multi-store support

`data/stores.json` is a flat array; add more entries (each with its own
`latitude`/`longitude`/`layout_id`) and a matching
`data/layouts/{layout_id}.json` file, and they show up automatically in
the store selector and API - no code changes required. Each store's
`anchor`/`transform` (scale/rotation/offsets) is independent, so
architecturally this scales to hundreds or thousands of stores; per-store
geo layouts are computed lazily and cached in memory the first time
they're requested.

---

## Security notes

- `store_id` path parameters are validated against a strict
  `^[A-Za-z0-9_-]{1,32}$` allow-list (`backend/store_service.py`) before
  ever being used to build a filesystem path.
- Layout files are only ever read from `data/layouts/`; the resolved path
  is additionally checked to still be inside that directory
  (`backend/layout_service.py::_layout_path`) as defense in depth against
  path traversal.
- Layout JSON is treated as untrusted data: it is parsed and validated
  through Pydantic models (`backend/models.py`) - coordinates are checked
  for NaN/Inf, geometry nesting is checked against its declared `type`,
  and nothing in it is ever executed as code.
- The `/calibrate` endpoint re-validates the full merged layout document
  with the same Pydantic models before writing it back to disk.

## Rack & inventory management (simulated stock)

The map includes a Rack & Inventory Management sidebar. **All inventory is
simulated**; nothing connects to a real Lowe's inventory system.

* `frontend/data/inventory/<store_id>.json` - one record for every shelf bay
  in the store (about 1,700-2,100 per store; slivers under 0.05 m2 skipped),
  built by `python scripts/generate_inventory.py [--stores 1665,2544]`.
  Each rack points at an existing bay in the store's `Lowes_rack`
  MultiPolygon (`geometry_ref`: feature + part index, plus the bay's source
  centroid, which the browser re-checks before linking). Map GeoJSON is never
  modified.
* Departments come from the most specific labelled department polygon
  containing the bay (`"Unassigned"` where that is not clear-cut). Aisles come
  from the numbered label in the walkway the bay faces (`aisle_source:
  "walkway"`), else the nearest numbered label within 12 m that no other bay
  hides (`"nearest"`). Bays with neither carry a `location` - the nearest named
  area such as "Back Wall" or "Garden Center" - shown as "Near Back Wall" (or
  "Lighting area" when it is the bay's own department).
* `frontend/inventory-data.js` holds the model (occupancy bands, stats,
  search, edits); `frontend/inventory.js` draws the overlay and sidebar.
  Edits are stored per store in browser `localStorage` and can be reset per
  rack or with **Reset inventory**.
* Occupancy colours: green > 70%, yellow 30-70%, red < 30%, grey vacant.
  Physical occupancy (slots) is tracked separately from stock (units).

## Online order picking & multi-cart routes (sample data)

The inventory sidebar has an **Order Picking** tab next to **Rack Inventory**.
It is a staff tool: store staff pick online orders with carts, pack them at
**Pack & Dispatch** in back-of-house and hand them to the delivery driver.
Orders are sample data generated for each store; nothing connects to a real
Lowe's order system.

Order steps: Pending -> Assigned -> Picking -> **Picked** -> **Packed** (Mark
Packed, at Pack & Dispatch) -> **Handed to driver** (Hand to Driver, per order
or all packed orders at once).

Build order: `generate_inventory.py` -> `build_store_zones.py` ->
`build_routing_network.py` -> `generate_sample_orders.py`.

* `python scripts/build_routing_network.py` - walking network per store in
  `frontend/data/routing/<store_id>.json`: a 0.5 m walkable grid built from
  mapped department floor, the front-end (6 m around checkout / service-desk
  markers), the back-of-house block and corridors narrower than 10 m between
  them, minus every rack, fixture and drawn outline grown by a 0.35 m cart
  clearance. Also stores each rack's picking access cell (racks with no
  walkable cell within 2 m are listed for review, not routed) and the **Pack &
  Dispatch** point (`dispatch`), where carts start and finish.
* `python scripts/generate_sample_orders.py` - 15 orders and the starting cart
  assignments per store in `frontend/data/orders/<store_id>.json`. Every line
  reuses an inventory SKU and its rack; only racks reachable from Pack &
  Dispatch are used.
* `frontend/indoor-routing.js` - routes follow the aisles and stay close to
  the shortest walk (about 5% longer on the sample carts): Dijkstra on the
  grid with straight moves inside aisles (the drawings are grid-aligned),
  diagonal moves only across open floor at least 2 m from shelving, a light
  cost per turn (1 m per 90 degrees), and a light cost for hugging shelving so
  routes keep to corridor centre lines. Parallel stretches of a cart's legs within 2 m share one drawn
  line, so walking out and back along a corridor is a single line. Stop order
  is exhaustive for up to 8 stops, nearest-neighbour + 2-opt above that (shown
  as a heuristic in the UI). Distances and times are measured on the drawn line.
* `frontend/order-management.js` - orders, carts, picks, packing, hand-over and
  the stock ledger (picks deduct from the Rack Inventory model once; undo and
  Reset Orders give the stock back). State is saved per store in `localStorage`.
* `frontend/picking-workflow.js` - map layers (`picking-routes`,
  `picking-target`) and the Order Picking tab.

Browser checks: `tests/test_order_picking_browser.py`.

## Back-of-house areas: Receiving, Pack & Dispatch, Returns

Staff-only areas for online-order fulfilment, all behind the sales floor
(nothing customer-facing). The maps mark no dock doors or area outlines; the
one back-of-house marker is the RECEIVING DESK (`icon_id: receiving_desk`, 15 of
16 stores - not Bloomfield #1665), always at the back of the building facing
the truck yard, so it stands in for the dock. `python scripts/build_store_zones.py`
writes `frontend/data/zones/<store_id>.json`:

* **Back-of-house block** - the back-room rack group the receiving desk sits in
  (racks outside the sales-floor departments, chained at gaps up to 4 m),
  outlined with the desk and kept off the sales floor.
* The block is divided along its length, each section keeping its racks as
  that area's shelving (`rack_ids`; Rack Details shows the "Storage area"):
  * **Receiving** (~50 %), centred on the receiving desk - supplier deliveries
    are checked in and put away;
  * **Pack & Dispatch** (~30 %), next to Receiving - carts start and finish
    here, orders are packed, staged and handed to the delivery driver;
  * **Returns** (~20 %), next to Pack & Dispatch - items brought back by
    delivery drivers wait for inspection.
* **No receiving desk** (Bloomfield) - the position is taken from the store
  with the most similar building (Southington #2910) and the nearest back-room
  rack group is used; the areas are labelled "estimated" (`source: "inferred"`).

`frontend/store-zones.js` draws them (Layers: "Back-of-house areas"); click an
area for its size and how it was placed. Check: `tests/test_store_zones.py`.

## Hosted site (Vercel)

Vercel serves `public/` from its CDN ahead of the FastAPI app, so
`public/index.html` is the page visitors see; the API and `frontend/data/`
are served by the app. After changing any HTML, JS or CSS in `frontend/`, run
`python scripts/sync_public.py` and commit `public/` with it
(`tests/test_public_sync.py` fails when the copies drift apart).

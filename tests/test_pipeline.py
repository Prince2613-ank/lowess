"""Unit tests for malformed data, parsing and durable resume semantics."""
import json
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lowes_pipeline import discovery
from lowes_pipeline.geojson import validate
from lowes_pipeline.catalog import Catalog


def fc(coordinates=None):
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": coordinates or [-86.8, 33.2]}}]}


def test_nested_all_layers_preserved():
    value = {"data": {"department": fc(), "aisle": fc(), "rack": fc()}, "other": "preserve"}
    before = json.dumps(value)
    assert len(validate(value)) == 3
    assert json.dumps(value) == before


@pytest.mark.parametrize("value", [{}, {"department": fc([float('nan'), 2])}, {"aisle": fc([400, 30])}, {"type": "FeatureCollection", "features": [{}]}])
def test_bad_geojson_rejected(value):
    with pytest.raises(ValueError):
        validate(value)


def test_unclosed_polygon():
    value = fc()
    value["features"][0]["geometry"] = {"type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,1]]]}
    with pytest.raises(ValueError, match="closed"):
        validate(value)


def test_discover_dynamic_states_multiple_stores_and_metadata():
    base = "https://www.lowes.com"
    regions = discovery.states('<a href="/Lowes-Stores/Alabama/AL">Alabama</a><a href="https://bad.test/Lowes-Stores/Test/ZZ">Bad</a>', base)
    assert [r['state'] for r in regions] == ['AL']
    page = '<a href="/store/AL-City/123">City</a><a href="/store/AL-City/456">City</a>'
    cities = discovery.cities(page, regions[0]['url'], 'AL')
    assert len(cities) == 2
    metadata = {'@type': 'HardwareStore', 'name': 'Test', 'address': {'streetAddress':'1 Main','addressLocality':'City','addressRegion':'AL','postalCode':'35000'}, 'geo': {'latitude':'33.2','longitude':'-86.8'}}
    entry = discovery.metadata('<script type="application/ld+json">'+json.dumps(metadata)+'</script>', base+'/store/AL-City/123')
    assert entry['store_id'] == '123' and entry['latitude'] == 33.2 and entry['zip'] == '35000'


def test_catalog_merge_resume_and_atomic_export(tmp_path):
    c = Catalog(tmp_path)
    c.put({'store_id':'123','state':'AL','city':'Test','map_status':'downloaded','map_file':'stores/AL/123/map.geojson'})
    c.put({'store_id':'123','name':'Updated'})
    c.close()
    c = Catalog(tmp_path)
    assert c.get('123')['map_status'] == 'downloaded'
    c.export()
    assert json.loads((tmp_path/'stores-index.json').read_text())['stores'][0]['name'] == 'Updated'
    c.close()


def test_catalog_api_no_legacy_map_fallback(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    c = Catalog(tmp_path)
    c.put({'store_id':'123','state':'AL','city':'Test','map_status':'failed'})
    c.export(); c.close()
    monkeypatch.setenv('LOWES_OUTPUT', str(tmp_path))
    client = TestClient(app)
    assert client.get('/api/catalog/stores').json()['stores'][0]['store_id'] == '123'
    assert client.get('/api/catalog/stores/123/map').status_code == 404
    assert client.get('/api/catalog/stores/1665/map').status_code == 404


def test_catalog_api_saves_details_and_raw_map(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app
    c = Catalog(tmp_path)
    c.put({'store_id':'123','state':'AL','city':'Test','map_status':'pending'})
    c.export(); c.close()
    monkeypatch.setenv('LOWES_OUTPUT', str(tmp_path))
    client = TestClient(app)

    details = {'store_id':'123','name':'Saved store','state':'AL','city':'Test','latitude':33.2,'longitude':-86.8}
    assert client.post('/api/catalog/stores/123/details', json=details).json()['name'] == 'Saved store'
    assert client.get('/api/catalog/stores/123/details').json()['latitude'] == 33.2

    raw_map = {'Lowes_aisle': fc(), 'Lowes_depertment': fc(), 'Lowes_rack': fc()}
    assert client.post('/api/catalog/stores/123/map', json=raw_map).json()['status'] == 'ok'
    assert client.get('/api/catalog/stores/123/map').json()['Lowes_aisle']['type'] == 'FeatureCollection'

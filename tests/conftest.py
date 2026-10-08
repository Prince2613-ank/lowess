import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


@pytest.fixture(autouse=True)
def _clear_caches():
    """Every test gets a clean slate: caches cleared before AND after, so
    tests that mutate data/ on disk (calibration saves, georeference saves)
    never leak stale cached state into the next test, and the real 1665
    fixtures are always reloaded fresh."""
    from backend import layout_service, store_service

    store_service.clear_cache()
    layout_service.invalidate("1665")
    yield
    store_service.clear_cache()
    layout_service.invalidate("1665")

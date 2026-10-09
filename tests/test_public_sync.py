"""public/ (served by Vercel) must match the frontend page files."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_public_page_files_match_frontend():
    frontend = ROOT / "frontend"
    stale = [p.name for p in frontend.iterdir()
             if p.is_file() and p.suffix in {".html", ".js", ".css"}
             and (ROOT / "public" / p.name).read_bytes() != p.read_bytes()]
    assert not stale, f"public/ is out of date ({', '.join(stale)}): run python scripts/sync_public.py"

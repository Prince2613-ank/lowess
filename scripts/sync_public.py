"""Copy the frontend page files into ``public/`` for the Vercel deployment.

Vercel serves ``public/`` straight from its CDN, ahead of the FastAPI app, so
``public/index.html`` is the page visitors get on the hosted site. Run this
after changing anything in ``frontend/`` (HTML, JS, CSS or vendored
libraries) and commit the result. Store data under ``frontend/data/`` is not
copied; the FastAPI app serves it.

Usage:  python scripts/sync_public.py
"""
from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
PUBLIC = ROOT / "public"
PAGE_SUFFIXES = {".html", ".js", ".css"}
VENDOR_DIRS = ["maplibre-gl"]


def main() -> None:
    copied = 0
    for path in sorted(FRONTEND.iterdir()):
        if path.is_file() and path.suffix in PAGE_SUFFIXES:
            shutil.copy2(path, PUBLIC / path.name)
            copied += 1
    for name in VENDOR_DIRS:
        shutil.copytree(FRONTEND / "vendor" / name, PUBLIC / "vendor" / name, dirs_exist_ok=True)
        copied += sum(1 for p in (FRONTEND / "vendor" / name).rglob("*") if p.is_file())
    print(f"Copied {copied} files from frontend/ to public/")


if __name__ == "__main__":
    main()

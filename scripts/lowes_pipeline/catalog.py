"""Atomic frontend exports and crash-resumable SQLite records."""
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


class Catalog:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "catalog.sqlite")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS stores (store_id TEXT PRIMARY KEY, state TEXT, city TEXT, map_status TEXT, last_updated TEXT, payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, fetched_at TEXT, html TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS failures (url TEXT PRIMARY KEY, phase TEXT, error TEXT, last_updated TEXT)")
        self.db.commit()

    def get(self, store_id):
        row = self.db.execute("SELECT payload FROM stores WHERE store_id=?", (store_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, entry):
        entry = {**(self.get(entry["store_id"]) or {}), **entry, "last_updated": now()}
        self.db.execute("INSERT OR REPLACE INTO stores VALUES (?,?,?,?,?,?)", (entry["store_id"], entry.get("state"), entry.get("city"), entry.get("map_status", "pending"), entry["last_updated"], json.dumps(entry)))
        self.db.commit()
        if entry.get("state"):
            write_json(self.root / "stores" / entry["state"] / entry["store_id"] / "store.json", entry)
        return entry

    def entries(self):
        return [json.loads(r[0]) for r in self.db.execute("SELECT payload FROM stores ORDER BY state, city, store_id")]

    def cached(self, url, max_age):
        row = self.db.execute("SELECT fetched_at,html FROM pages WHERE url=?", (url,)).fetchone()
        if row and (datetime.now(timezone.utc) - datetime.fromisoformat(row[0])).total_seconds() < max_age:
            return row[1]

    def cache(self, url, html):
        self.db.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?)", (url, now(), html))
        self.db.execute("DELETE FROM failures WHERE url=?", (url,))
        self.db.commit()

    def failure(self, url, phase, error):
        self.db.execute("INSERT OR REPLACE INTO failures VALUES (?,?,?,?)", (url, phase, str(error), now()))
        self.db.commit()

    def export(self):
        write_json(self.root / "stores-index.json", {"updated": now(), "stores": self.entries()})

    def close(self):
        self.db.close()

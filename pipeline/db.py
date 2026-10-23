"""
db.py - Job state persistence with SQLite, local disk backup, and optional Supabase.

Persists job state: (job_id, url, stage, status, events, updated_at, tool, slug, job_type, results).
Allows GET /api/job/<id> to survive server restarts and recover state cleanly.
"""

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import sqlite3
import threading

import requests

log = logging.getLogger("db")

ROOT = Path(__file__).resolve().parent.parent
# REEL_DATA_DIR puts jobs.db on a persistent disk (e.g. a Render disk); the container's own
# filesystem is wiped on every restart, so without it (or Supabase) job state can't survive one.
DATA_DIR = Path(os.environ.get("REEL_DATA_DIR") or ROOT / "data").resolve()
DB_PATH = DATA_DIR / "jobs.db"
_db_lock = threading.Lock()
_supabase_full_columns = True  # set False once the table rejects the extra columns


def _supabase_config():
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = (
        os.environ.get("SUPABASE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    )
    table = os.environ.get("SUPABASE_TABLE", "jobs").strip()
    return url, key, table


def _init_sqlite():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _db_lock, sqlite3.connect(str(DB_PATH), timeout=10) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                url TEXT,
                stage TEXT,
                status TEXT,
                events TEXT,
                tool TEXT,
                slug TEXT,
                type TEXT,
                results TEXT,
                drive TEXT,
                started REAL,
                updated_at TEXT
            )
        """)
        conn.commit()


_init_sqlite()


def save_job_state(
    job_id,
    url="",
    stage="",
    status="running",
    events=None,
    tool=None,
    slug=None,
    out_dir=None,
    job_type="run",
    results=None,
    drive=None,
    started=None,
):
    """
    Persist job state to SQLite and local disk backup, with optional Supabase upsert.
    """
    if events is None:
        events = []
    elif isinstance(events, str):
        try:
            events = json.loads(events)
        except Exception:
            events = [events]

    now_iso = datetime.now(timezone.utc).isoformat()
    events_json = json.dumps(events, ensure_ascii=False)
    results_json = json.dumps(results or [], ensure_ascii=False) if results is not None else "[]"

    payload = {
        "job_id": str(job_id),
        "url": str(url or ""),
        "stage": str(stage or ""),
        "status": str(status or "pending"),
        "events": events,
        "tool": str(tool or slug or ""),
        "slug": str(slug or tool or ""),
        "type": str(job_type or "run"),
        "results": results or [],
        "drive": drive,
        "started": float(started) if started else None,
        "updated_at": now_iso,
    }

    # 1. SQLite durable store
    try:
        with _db_lock, sqlite3.connect(str(DB_PATH), timeout=10) as conn:
            conn.execute(
                """
                INSERT INTO jobs (job_id, url, stage, status, events, tool, slug, type, results, drive, started, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    url=excluded.url,
                    stage=excluded.stage,
                    status=excluded.status,
                    events=excluded.events,
                    tool=excluded.tool,
                    slug=excluded.slug,
                    type=excluded.type,
                    results=excluded.results,
                    drive=excluded.drive,
                    started=COALESCE(excluded.started, jobs.started),
                    updated_at=excluded.updated_at
            """,
                (
                    str(job_id),
                    str(url or ""),
                    str(stage or ""),
                    str(status or "pending"),
                    events_json,
                    str(tool or slug or ""),
                    str(slug or tool or ""),
                    str(job_type or "run"),
                    results_json,
                    str(drive) if drive else None,
                    float(started) if started else None,
                    now_iso,
                ),
            )
            conn.commit()
    except Exception as e:
        log.warning("Could not persist job %s to SQLite: %s", job_id, e)

    # 2. Local disk backup (.jobs/<job_id>.json)
    try:
        root_out = Path(out_dir) if out_dir else ROOT / "out"
        jobs_dir = root_out / ".jobs"
        jobs_dir.mkdir(parents=True, exist_ok=True)
        (jobs_dir / f"{job_id}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        log.debug("Disk job backup error: %s", e)

    # 3. Optional Supabase PostgREST Upsert (the only store that survives a Render restart
    # without a disk). Sends every field; if the table only has the core columns, falls back.
    global _supabase_full_columns
    supabase_url, supabase_key, table = _supabase_config()
    if supabase_url and supabase_key:
        try:
            endpoint = f"{supabase_url}/rest/v1/{table}"
            headers = {
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            }
            core_payload = {
                "job_id": payload["job_id"],
                "url": payload["url"],
                "stage": payload["stage"],
                "status": payload["status"],
                "events": payload["events"],
                "updated_at": payload["updated_at"],
            }
            res = None
            if _supabase_full_columns:
                res = requests.post(endpoint, headers=headers, json=payload, timeout=5)
                if res.status_code == 400 and "column" in res.text.lower():
                    _supabase_full_columns = False
                    log.warning("Supabase table %s has only the core job columns; add tool, slug, type, results, "
                                "drive, started to keep those across restarts", table)
                    res = None
            if res is None:
                res = requests.post(endpoint, headers=headers, json=core_payload, timeout=5)
            if not res.ok:
                log.warning("Supabase upsert status %d: %s", res.status_code, res.text[:200])
        except Exception as e:
            log.warning("Could not persist job %s to Supabase: %s", job_id, e)


def _row_to_dict(row):
    jid, url, stage, status, events_str, tool, slug, job_type, results_str, drive, started, updated_at = row
    events = []
    if events_str:
        try:
            events = json.loads(events_str)
        except Exception:
            events = [events_str]
    results = []
    if results_str:
        try:
            results = json.loads(results_str)
        except Exception:
            results = []
    return {
        "job_id": jid,
        "url": url or "",
        "stage": stage or "",
        "status": status or "unknown",
        "events": events,
        "tool": tool or slug or "",
        "slug": slug or tool or "",
        "type": job_type or "run",
        "results": results,
        "drive": drive,
        "started": started,
        "updated_at": updated_at,
    }


def get_job_state(job_id, out_dir=None):
    """
    Retrieve job state from SQLite, disk fallback, or Supabase. Returns dict or None.
    """
    # 1. Check SQLite
    try:
        with _db_lock, sqlite3.connect(str(DB_PATH), timeout=10) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT job_id, url, stage, status, events, tool, slug, type, results, drive, started, updated_at FROM jobs WHERE job_id = ?",
                (str(job_id),),
            )
            row = cursor.fetchone()
            if row:
                return _row_to_dict(row)
    except Exception as e:
        log.debug("Error reading SQLite job %s: %s", job_id, e)

    # 2. Check local disk fallback
    try:
        root_out = Path(out_dir) if out_dir else ROOT / "out"
        backup_file = root_out / ".jobs" / f"{job_id}.json"
        if backup_file.is_file():
            data = json.loads(backup_file.read_text(encoding="utf-8"))
            if data and isinstance(data, dict):
                return data
    except Exception as e:
        log.debug("Error reading disk job fallback: %s", e)

    # 3. Check Supabase
    supabase_url, supabase_key, table = _supabase_config()
    if supabase_url and supabase_key:
        try:
            endpoint = f"{supabase_url}/rest/v1/{table}?job_id=eq.{job_id}&select=*"
            headers = {
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
            }
            res = requests.get(endpoint, headers=headers, timeout=5)
            if res.ok:
                rows = res.json()
                if rows and isinstance(rows, list):
                    return rows[0]
        except Exception as e:
            log.warning("Error fetching job %s from Supabase: %s", job_id, e)

    return None


def list_all_jobs(out_dir=None):
    """
    Return all jobs known in durable store (SQLite + disk backup).
    """
    jobs_map = {}

    # Read from SQLite
    try:
        with _db_lock, sqlite3.connect(str(DB_PATH), timeout=10) as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT job_id, url, stage, status, events, tool, slug, type, results, drive, started, updated_at FROM jobs"
            )
            for row in cursor.fetchall():
                d = _row_to_dict(row)
                if d.get("job_id"):
                    jobs_map[d["job_id"]] = d
    except Exception as e:
        log.debug("Error listing SQLite jobs: %s", e)

    # Merge any .jobs/*.json that might be on disk
    try:
        root_out = Path(out_dir) if out_dir else ROOT / "out"
        jobs_dir = root_out / ".jobs"
        if jobs_dir.is_dir():
            for p in jobs_dir.glob("*.json"):
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    jid = data.get("job_id") or p.stem
                    if jid and jid not in jobs_map:
                        jobs_map[jid] = data
                except Exception:
                    pass
    except Exception as e:
        log.debug("Error reading disk jobs dir: %s", e)

    return list(jobs_map.values())

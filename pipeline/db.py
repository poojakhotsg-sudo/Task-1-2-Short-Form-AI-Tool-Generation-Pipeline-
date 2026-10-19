"""
db.py - Job state persistence with Supabase (and local disk backup).

Persists job state: (job_id, url, stage, status, events, updated_at).
Allows GET /api/job/<id> to survive server restarts.
"""

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path

import requests

log = logging.getLogger("db")


def _supabase_config():
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = (
        os.environ.get("SUPABASE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    )
    table = os.environ.get("SUPABASE_TABLE", "jobs").strip()
    return url, key, table


def save_job_state(job_id, url="", stage="", status="running", events=None, tool=None, slug=None, out_dir=None):
    """
    Persist job state to Supabase, with an automatic local disk backup.
    """
    if events is None:
        events = []
    elif isinstance(events, str):
        events = [events]

    now_iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "job_id": str(job_id),
        "url": str(url or ""),
        "stage": str(stage or ""),
        "status": str(status or "pending"),
        "events": events,
        "updated_at": now_iso,
    }
    # Optional metadata if table supports extra columns
    if tool:
        payload["tool"] = str(tool)
    if slug:
        payload["slug"] = str(slug)

    # 1. Supabase PostgREST Upsert
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
            # Only send core fields to avoid column mismatch errors
            core_payload = {
                "job_id": payload["job_id"],
                "url": payload["url"],
                "stage": payload["stage"],
                "status": payload["status"],
                "events": payload["events"],
                "updated_at": payload["updated_at"],
            }
            res = requests.post(endpoint, headers=headers, json=core_payload, timeout=5)
            if not res.ok:
                log.warning("Supabase upsert status %d: %s", res.status_code, res.text[:200])
        except Exception as e:
            log.warning("Could not persist job %s to Supabase: %s", job_id, e)

    # 2. Local disk backup (survives worker crashes if storage persists)
    try:
        root_out = Path(out_dir) if out_dir else Path(__file__).resolve().parent.parent / "out"
        jobs_dir = root_out / ".jobs"
        jobs_dir.mkdir(parents=True, exist_ok=True)
        (jobs_dir / f"{job_id}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        log.debug("Disk job backup error: %s", e)


def get_job_state(job_id, out_dir=None):
    """
    Retrieve job state from Supabase if available, falling back to local disk.
    Returns dict or None.
    """
    supabase_url, supabase_key, table = _supabase_config()

    # 1. Check Supabase
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

    # 2. Check local disk fallback
    try:
        root_out = Path(out_dir) if out_dir else Path(__file__).resolve().parent.parent / "out"
        backup_file = root_out / ".jobs" / f"{job_id}.json"
        if backup_file.is_file():
            return json.loads(backup_file.read_text(encoding="utf-8"))
    except Exception as e:
        log.debug("Error reading disk job fallback: %s", e)

    return None

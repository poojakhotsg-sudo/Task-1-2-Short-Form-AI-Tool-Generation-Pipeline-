"""
app.py - UI for the extractor and the pipeline (web/*.html + JSON endpoints).

    uvicorn app:app --reload      then open http://127.0.0.1:8000

/ is the asset extractor: paste a URL, press Extract, see the GIFs/videos and
images. Diagnostics go to out/<tool>/report.json and run.log, not the page.

/pipeline: Run starts `python run.py` in the background with a live log. For the latest
run, or any earlier tool picked from the dropdown, the page shows the website
data, the script and the shot list with clip previews, uploads for missing
shots, a zip download and the Drive link. out/ is served at /out for video.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import BackgroundTasks, Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from extract_assets import tool_name as site_folder
import gallery
from pipeline import qa
from pipeline.grabber import H, W, slugify

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
OUT = Path(os.environ.get("REEL_OUT_DIR") or ROOT / "out").resolve()  # override for testing
OUT.mkdir(parents=True, exist_ok=True)
DRIVE_RE = re.compile(r"https://drive\.google\.com/drive/folders/[\w-]+")
MAX_UPLOAD_MB = 1000

app = FastAPI(title="reel-pipeline")
app.mount("/out", StaticFiles(directory=OUT), name="out")

jobs = {}  # job_id -> {"tool", "slug", "url", "num", "status", "log", "proc", "drive", "started"}
lock = threading.Lock()


# ---------- helpers ----------

def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def read_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def tool_dir(slug):
    # Extractor folders are named after the domain (gamma.app); pipeline folders are slugs.
    slug = slug if re.fullmatch(r"[a-z0-9][a-z0-9.-]*", slug or "") and ".." not in slug else slugify(slug)
    d = OUT / slug
    if not slug or not d.is_dir():
        raise HTTPException(404, f"No results for '{slug}'.")
    return d


def url_for(d, rel):
    """Public URL for a file under out/<tool>/, with an mtime cache-buster, or None if missing."""
    if not rel:
        return None
    p = d / rel
    if not p.is_file():
        return None
    return f"/out/{quote(d.name)}/{quote(Path(rel).as_posix())}?v={int(p.stat().st_mtime)}"


def busy(slug):
    return next((jid for jid, j in jobs.items() if j["slug"] == slug and j["status"] in ("running", "stopping")), None)


def format_bytes(num_bytes):
    if num_bytes < 1024:
        return f"{num_bytes} B"
    elif num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    elif num_bytes < 1024 * 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{num_bytes / (1024 * 1024 * 1024):.2f} GB"


# ---------- background run ----------

def worker(job_id):
    job = jobs[job_id]
    cmd = [sys.executable, "-u", str(ROOT / "run.py"), "--tool", job["tool"], "--url", job["url"], "--out", str(OUT)]
    if job["num"]:
        cmd += ["--num", job["num"]]
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONWARNINGS": "ignore"}
    try:
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", env=env)
    except OSError as e:
        job["log"].append(f"could not start run.py: {e}")
        job["status"] = "failed"
        return
    job["proc"] = proc
    for line in proc.stdout:
        line = line.rstrip("\n")
        job["log"].append(line)
        if "Drive folder:" in line and (m := DRIVE_RE.search(line)):
            job["drive"] = m.group(0)
    code = proc.wait()
    if job["status"] == "stopping":
        job["status"] = "stopped"
    else:
        job["status"] = "done" if code == 0 else "failed"
        if code:
            job["log"].append(f"run.py exited with code {code}")


@app.post("/api/run")
def start_run(tool: str = Form(...), url: str = Form(...), num: str = Form("")):
    tool, url, num = tool.strip(), url.strip(), num.strip()
    slug = slugify(tool)
    if not slug:
        raise HTTPException(400, "Tool name needs at least one letter or number.")
    if not re.match(r"^(https?://)?[\w.-]+\.[a-z]{2,}(/\S*)?$", url, re.I):
        raise HTTPException(400, "That doesn't look like a website URL.")
    if num and not re.fullmatch(r"\d{1,3}", num):
        raise HTTPException(400, "Number must be 1-3 digits, e.g. 01.")
    with lock:
        existing = busy(slug)
        if existing:
            return {"job": existing, "slug": slug, "already_running": True}
        job_id = uuid.uuid4().hex[:8]
        jobs[job_id] = {"tool": tool, "slug": slug, "url": url, "num": num, "status": "running",
                        "log": [], "proc": None, "drive": None, "started": time.time()}
    threading.Thread(target=worker, args=(job_id,), daemon=True).start()
    return {"job": job_id, "slug": slug, "already_running": False}


EXTRACT_NAME_RE = re.compile(r"[a-z0-9][a-z0-9.-]*")


def asset_worker(job_id):
    """Run extract_assets.py for each URL of the batch, one after another. A failed URL doesn't stop the rest."""
    job = jobs[job_id]
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONWARNINGS": "ignore"}
    for i, (url, name) in enumerate(zip(job["urls"], job["names"]), 1):
        if job["status"] == "stopping":
            break
        job.update(index=i, url=url, slug=name)
        job["log"].append(f"> Extracting {i} of {len(job['urls'])}: {url}")
        cmd = [sys.executable, "-u", str(ROOT / "extract_assets.py"), "--url", url, "--out", str(OUT / name)]
        try:
            proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", env=env)
        except OSError as e:
            job["log"].append(f"could not start extract_assets.py: {e}")
            job["results"].append({"name": name, "url": url, "status": "failed"})
            continue
        job["proc"] = proc
        for line in proc.stdout:
            job["log"].append(line.rstrip("\n"))
        code = proc.wait()
        job["results"].append({"name": name, "url": url, "status": "ok" if code == 0 else "failed"})
    job["status"] = "stopped" if job["status"] == "stopping" else "done"


URL_RE = re.compile(r"^https?://[\w.-]+\.[a-z]{2,}(:\d+)?(/\S*)?$", re.I)


@app.post("/api/extract")
def start_extract(url: str = Form(...)):
    """One or more URLs, one per line; extracted one after another into out/<domain>/."""
    urls = []
    for u in re.split(r"[\s,]+", url.strip()):
        if not u:
            continue
        u = u if re.match(r"^https?://", u, re.I) else "https://" + u
        if not URL_RE.match(u):
            raise HTTPException(400, f"That doesn't look like a website URL: {u}")
        if u not in urls:
            urls.append(u)
    if not urls:
        raise HTTPException(400, "Paste at least one website URL.")
    names = [site_folder(u) for u in urls]
    with lock:
        existing = next((jid for jid, j in jobs.items() if j.get("type") == "extract" and j["status"] in ("running", "stopping")), None)
        if existing:
            j = jobs[existing]
            return {"job": existing, "names": j["names"], "already_running": True}
        job_id = uuid.uuid4().hex[:8]
        jobs[job_id] = {"tool": names[0], "slug": names[0], "url": urls[0], "urls": urls, "names": names, "index": 0,
                        "results": [], "num": "", "status": "running", "log": [], "proc": None, "drive": None,
                        "started": time.time(), "type": "extract"}
    threading.Thread(target=asset_worker, args=(job_id,), daemon=True).start()
    return {"job": job_id, "names": names, "already_running": False}


def extract_dir(name):
    if not EXTRACT_NAME_RE.fullmatch(name or "") or ".." in name:
        raise HTTPException(404, "Nothing extracted for that site yet.")
    d = OUT / name
    m = read_json(d / "manifest.json")
    if not isinstance(m, dict) or m.get("kind") != "extract":
        raise HTTPException(404, "Nothing extracted for that site yet.")
    return d, m


EMPTY_LINES = {"scroll": "No scroll video for this page.", "embedded": "No embedded clips found on this page.",
               "gifs": "No GIFs found on this page.", "images": "No images found on this page."}


@app.get("/api/extract-runs")
def extract_runs():
    """The Recent dropdown: one entry per extracted URL, newest first."""
    runs = []
    for d in OUT.iterdir():
        m = read_json(d / "manifest.json") if d.is_dir() else None
        if isinstance(m, dict) and m.get("kind") == "extract":
            runs.append({"name": d.name, "url": m.get("url"), "status": m.get("status"), "counts": m.get("counts", {}),
                         "updated": int((d / "manifest.json").stat().st_mtime)})
    runs.sort(key=lambda r: -r["updated"])
    running = next((j for j in jobs.values() if j.get("type") == "extract" and j["status"] in ("running", "stopping")), None)
    return {"runs": runs, "running": running and running["slug"]}


@app.get("/api/extract/{name}")
def extract_result(name: str):
    """One saved run, split into the four categories (no diagnostics; those stay in report.json/run.log)."""
    d, m = extract_dir(name)
    cats = {"scroll": [], "embedded": [], "gifs": [], "images": []}
    for it in m.get("items", []):
        if it.get("category") not in cats:
            continue
        cats[it["category"]].append({
            "filename": it.get("filename"), "type": it.get("type"), "path": it.get("path"), "mp4": it.get("mp4"),
            "url": url_for(d, it.get("path")), "mp4_url": url_for(d, it.get("mp4")),
            "width": it.get("width"), "height": it.get("height"), "duration": it.get("duration"),
            "size": it.get("size_bytes") or 0, "mp4_size": it.get("mp4_size_bytes"),
            "order": it.get("page_order") or 0, "section": it.get("section", ""),
            "mtime": int((d / it["path"]).stat().st_mtime) if it.get("path") and (d / it["path"]).is_file() else 0,
        })
    return {"name": d.name, "url": m.get("url"), "status": m.get("status"), "message": m.get("message", ""),
            "finished": m.get("finished"), "categories": cats,
            "counts": {k: len(v) for k, v in cats.items()},
            "empty": {k: EMPTY_LINES[k] for k, v in cats.items() if not v}}


@app.get("/api/job/{job_id}")
def job_status(job_id: str, since: int = 0):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "That run isn't known to this server (it may have restarted).")
    lines = job["log"][since:]
    stage = ""
    for ln in reversed(job["log"]):
        if "[PROGRESS]" in ln:
            stage = ln.split("[PROGRESS]")[-1].strip()
            break
        elif "Downloaded " in ln and " files" in ln:
            stage = ln.strip()
            break
        elif "Scrolling " in ln:
            stage = "Scrolling page..."
            break
        elif "Navigating to " in ln:
            stage = "Navigating to page..."
            break
        elif ln.startswith("> "):
            stage = ln.strip()[2:].rstrip(" .")
            break
    secs = int(time.time() - job["started"])
    return {"status": job["status"], "lines": lines, "next": since + len(lines), "slug": job["slug"],
            "tool": job["tool"], "stage": stage if job["status"] == "running" else "",
            "elapsed": f"{secs // 60}:{secs % 60:02d}", "drive": job["drive"],
            "index": job.get("index"), "total": len(job.get("urls") or []) or None, "names": job.get("names"),
            "results": job.get("results")}


@app.post("/api/job/{job_id}/stop")
def job_stop(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "No such run.")
    if job["status"] == "running" and job["proc"]:
        job["status"] = "stopping"
        job["log"].append("stopping...")
        job["proc"].terminate()
    return {"status": job["status"]}


# ---------- results ----------

@app.get("/api/tools")
def list_tools():
    tools = []
    for d in sorted(p for p in OUT.iterdir() if p.is_dir()):
        files = [n for n in ("manifest.json", "site_data.json", "script.txt", "shot_list.json", "assets.json", "gallery.html") if (d / n).exists()]
        if files:
            tools.append({"slug": d.name, "updated": max(int((d / n).stat().st_mtime) for n in files)})
    running = {j["slug"]: jid for jid, j in jobs.items() if j["status"] in ("running", "stopping")}
    return {"tools": tools, "running": running}


def load_shot_list(d, manifest):
    sl = read_json(d / "shot_list.json")
    if sl is None and manifest and manifest.get("shot_list"):
        sl = read_json(Path(manifest["shot_list"]))
    return sl if isinstance(sl, list) else []


def shot_rows(d, manifest):
    """One row per shot, merging shot_list.json (script) with manifest.json (clip + status)."""
    by_num = {}
    for s in load_shot_list(d, manifest):
        if isinstance(s, dict) and "shot" in s:
            by_num[s["shot"]] = {"shot": s["shot"], "script_line": s.get("script_line", ""),
                                 "visual_needed": s.get("visual_needed", ""), "source": s.get("source"),
                                 "duration": s.get("duration_seconds")}
    clips = (manifest or {}).get("clips") or {}
    for s in (manifest or {}).get("shots", []):
        row = by_num.setdefault(s["shot"], {"shot": s["shot"], "duration": None})
        for k in ("script_line", "visual_needed", "source"):
            if not row.get(k):
                row[k] = s.get(k)
        row["_m"] = s
    rows = []
    for n in sorted(by_num):
        row, s = by_num[n], by_num[n].pop("_m", {})
        src = url_for(d, s.get("file"))
        qa_state = (clips.get(str(n)) or {}).get("status") or s.get("qa")
        manual = s.get("status") == "manual"
        if src and (manual or qa_state == "pass"):
            badge = "covered"
        elif s.get("status") == "needs_manual":
            badge = "needs_manual"
        else:
            badge = "missing"
        if badge == "covered":
            reason = ("Manual upload. QA notes: " + "; ".join(s["qa_reasons"])) if manual and s.get("qa_reasons") else ""
        else:
            reason = ((clips.get(str(n)) or {}).get("reason") or "; ".join(s.get("qa_reasons") or [])
                      or s.get("trial_error") or s.get("error") or ("no clip yet" if not src else ""))
        score = s.get("match_score")
        if score is None and isinstance(s.get("matched"), dict):
            score = s["matched"].get("score")
        rows.append({**row, "source": row.get("source") or "-", "clip": src, "badge": badge, "reason": reason,
                     "manual": manual, "match_score": score, "screenshot": url_for(d, s.get("screenshot"))})
    return rows


@app.get("/api/tool/{slug}")
def tool_results(slug: str):
    d = tool_dir(slug)
    manifest = read_json(d / "manifest.json")
    if not isinstance(manifest, dict):  # extractor folders hold a list manifest
        manifest = None
    site = read_json(d / "site_data.json")
    if isinstance(site, dict):
        site = {**site, "hero_url": url_for(d, site.get("hero_png") or "hero.png")}
    else:
        site = None
    rows = shot_rows(d, manifest)
    drive = next((j["drive"] for j in reversed(list(jobs.values())) if j["slug"] == d.name and j["drive"]), None)
    if not drive:
        drive = (DRIVE_RE.findall(read_text(d / "run.log") or "") or [None])[-1]

    # Extracted media assets
    assets = read_json(d / "assets.json")
    failed_downloads = read_json(d / "failed_downloads.json", default=[])
    assets_summary = None
    all_assets = []
    tool_url = (manifest or {}).get("url") or (site or {}).get("url")
    if isinstance(assets, list) and assets:
        total_sz = sum(a.get("size_bytes", 0) for a in assets)
        if not tool_url:
            tool_url = assets[0].get("source_url")
        assets_summary = {
            "total": len(assets),
            "images": sum(1 for a in assets if a.get("type") in ("image", "svg")),
            "gifs": sum(1 for a in assets if a.get("type") == "gif"),
            "videos": sum(1 for a in assets if a.get("type") in ("video", "embed")),
            "embeds": sum(1 for a in assets if a.get("type") == "embed"),
            "failed": len(failed_downloads),
            "size_human": format_bytes(total_sz),
        }
        for a in assets:
            fp = a.get("file_path")
            all_assets.append({
                **a,
                "public_url": f"/out/{d.name}/{fp}" if fp else None,
            })

    return {
        "slug": d.name,
        "tool": (manifest or {}).get("tool") or d.name,
        "url": tool_url,
        "site": site, "script": read_text(d / "script.txt"), "shots": rows,
        "summary": {"covered": sum(r["badge"] == "covered" for r in rows), "total": len(rows),
                    "missing": sum(r["badge"] == "missing" for r in rows),
                    "needs_manual": sum(r["badge"] == "needs_manual" for r in rows)},
        "rough_cut": url_for(d, "rough_cut.mp4"), "summary_md": url_for(d, "summary.md"),
        "run_log": url_for(d, "run.log"), "drive": drive,
        "has_manifest": manifest is not None, "running": busy(d.name),
        "gallery_url": url_for(d, "gallery.html"),
        "assets_json_url": url_for(d, "assets.json"),
        "assets_summary": assets_summary,
        "assets": all_assets,
        "failed_downloads": failed_downloads,
        "gallery": gallery.build(d),
        "playwright_report": (pw := read_json(d / "playwright_report.json")),
        "blocked": bool(pw and pw.get("blocked")),
        "blocked_message": (pw.get("blocked_message") if pw else "") or "Blocked: use the marketing URL or tick Show browser",
        "scroll_video_url": url_for(d, "gifs_videos/00_page_scroll.mp4"),
        "above_the_fold_url": url_for(d, "above_the_fold.png"),
        "page_mobile_url": url_for(d, "page_mobile.png"),
        # Diagnostics stay in report.json / run.log on disk; the page only gets the one-line outcome.
        "message": (read_json(d / "report.json") or {}).get("message", ""),
    }


# ---------- manual clip upload ----------

def normalize_clip(src, out):
    """Re-encode a phone/screen recording to 1080x1920 H.264 so it plays everywhere and fits the reel."""
    vf = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,fps=30"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-vf", vf, "-c:v", "libx264", "-preset", "medium",
           "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(out)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        raise HTTPException(400, "Converting that video took too long.")
    if r.returncode != 0 or not out.exists():
        detail = (r.stderr.strip().splitlines() or [""])[-1][:200]
        raise HTTPException(400, f"Couldn't read that file as a video. {detail}".strip())


@app.post("/api/tool/{slug}/shot/{shot}/upload")
def upload_clip(slug: str, shot: int, file: UploadFile = File(...)):
    d = tool_dir(slug)
    if busy(d.name):
        raise HTTPException(409, "A run is in progress for this tool; wait for it to finish.")
    mpath = d / "manifest.json"
    manifest = read_json(mpath)
    if not isinstance(manifest, dict) or "shots" not in manifest:
        raise HTTPException(400, "This tool has no manifest.json yet; run the pipeline first.")
    entry = next((s for s in manifest["shots"] if s.get("shot") == shot), None)
    if entry is None:  # in shot_list.json but the grabber never saw it
        sl = {s.get("shot"): s for s in load_shot_list(d, manifest) if isinstance(s, dict)}
        if shot not in sl:
            raise HTTPException(404, f"No shot {shot} in this tool's shot list.")
        entry = {"shot": shot, "source": sl[shot].get("source"), "visual_needed": sl[shot].get("visual_needed", ""),
                 "script_line": sl[shot].get("script_line", ""), "file": None}
        manifest["shots"].append(entry)
        manifest["shots"].sort(key=lambda s: s["shot"])

    clips_dir = d / "clips"
    clips_dir.mkdir(exist_ok=True)
    name = f"shot{shot:02d}_manual.mp4"
    with tempfile.TemporaryDirectory() as tmp:
        ext = re.sub(r"[^.a-z0-9]", "", Path(file.filename or "").suffix.lower())[:6] or ".bin"
        raw = Path(tmp) / f"upload{ext}"
        size = 0
        with raw.open("wb") as f:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_MB * 1024 * 1024:
                    raise HTTPException(413, f"File is over {MAX_UPLOAD_MB} MB.")
                f.write(chunk)
        if size == 0:
            raise HTTPException(400, "The uploaded file is empty.")
        fixed = Path(tmp) / name
        normalize_clip(raw, fixed)
        shutil.move(str(fixed), clips_dir / name)

    with lock:
        metrics, reasons = qa.check_clip(clips_dir / name)
        entry.update(file=f"clips/{name}", status="manual", trial_error=None, error=None,
                     qa="fail" if reasons else "pass", qa_reasons=reasons, qa_metrics=metrics,
                     seconds=metrics.get("seconds"))
        qa.refresh_clip_map(manifest, d)
        tmpm = mpath.with_suffix(".json.tmp")
        tmpm.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmpm, mpath)
    return {"ok": True, "file": f"clips/{name}", "qa_notes": reasons}


# ---------- zip download ----------

STORED = {".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".webp", ".zip"}  # already compressed


@app.post("/api/tool/{slug}/zip-selected")
def download_selected(slug: str, background: BackgroundTasks, files: list[str] = Body(..., embed=True)):
    """Zip of the gallery files ticked on the page (paths relative to out/<tool>/)."""
    d = tool_dir(slug)
    picked = []
    for rel in files:
        p = (d / rel).resolve()
        if p.is_file() and p.is_relative_to(d.resolve()):
            picked.append(p)
    if not picked:
        raise HTTPException(400, "Nothing selected that can be downloaded.")
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w") as z:
        for p in picked:
            z.write(p, f"{d.name}/{p.relative_to(d.resolve()).as_posix()}",
                    compress_type=zipfile.ZIP_STORED if p.suffix.lower() in STORED else zipfile.ZIP_DEFLATED)
    background.add_task(os.remove, tmp)
    return FileResponse(tmp, media_type="application/zip", filename=f"{d.name}-selected.zip")


@app.get("/api/tool/{slug}/zip")
def download_zip(slug: str, background: BackgroundTasks):
    d = tool_dir(slug)
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w") as z:
        for p in sorted(d.rglob("*")):
            if p.is_file() and not p.name.endswith(".tmp"):
                z.write(p, f"{d.name}/{p.relative_to(d).as_posix()}",
                        compress_type=zipfile.ZIP_STORED if p.suffix.lower() in STORED else zipfile.ZIP_DEFLATED)
    background.add_task(os.remove, tmp)
    return FileResponse(tmp, media_type="application/zip", filename=f"{d.name}.zip")


# ---------- config & script & assemble endpoints ----------

@app.get("/api/config")
def get_config():
    has_key = bool(
        os.environ.get("ANTHROPIC_API_KEY", "").strip()
        or os.environ.get("GROK_API_KEY", "").strip()
        or os.environ.get("GROQ_API_KEY", "").strip()
    )
    return {"has_ai_key": has_key}


@app.post("/api/tool/{slug}/script/auto")
def auto_build_script(slug: str):
    d = tool_dir(slug)
    site = read_json(d / "site_data.json") or {}
    tool_name = site.get("tool") or slug.capitalize()
    desc = site.get("description") or site.get("title") or "The modern AI tool for everyone."
    sections = site.get("sections") or []

    weak = re.compile(r"faq|frequently|cookie|footer|privacy|terms|login|sign ?in|copyright", re.I)
    good_sections = [s for s in sections if not weak.search(s.get("heading", ""))]
    if not good_sections:
        good_sections = sections[:4] if sections else [
            {"heading": "Create effortlessly", "text": "Start with a single prompt or idea."},
            {"heading": "Customize everything", "text": "Refine styles, templates, and content in real time."},
            {"heading": "Export and share", "text": "Publish or download your creations instantly."}
        ]

    shots = []
    lines = []
    t = 0.0

    # 1. Hook
    hook_dur = 4.0
    hook_heading = good_sections[0]["heading"] if good_sections else tool_name
    hook_line = f"This is {tool_name} — {desc[:90].rstrip('.')}."
    shots.append({
        "shot": 1,
        "time": f"[{int(t)}-{int(t+hook_dur)}s]",
        "duration_seconds": hook_dur,
        "script_line": hook_line,
        "source": "website",
        "visual_needed": hook_heading,
    })
    lines.append(f"[{int(t)}-{int(t+hook_dur)}s] HOOK - {hook_heading.upper()}\n{hook_line}\n")
    t += hook_dur

    # 2. Steps (2 to 4 features)
    step_sections = good_sections[1:5] if len(good_sections) > 1 else good_sections
    for idx, s in enumerate(step_sections[:4], start=1):
        dur = 4.0
        h_text = s.get("heading", f"Feature {idx}")
        s_line = s.get("text", h_text)
        if len(s_line) > 120:
            s_line = s_line[:120].rsplit(" ", 1)[0] + "."
        shots.append({
            "shot": len(shots) + 1,
            "time": f"[{int(t)}-{int(t+dur)}s]",
            "duration_seconds": dur,
            "script_line": s_line,
            "source": "website",
            "visual_needed": h_text,
        })
        lines.append(f"[{int(t)}-{int(t+dur)}s] STEP {idx} - {h_text.upper()}\n{s_line}\n")
        t += dur

    # 3. CTA
    cta_dur = 3.0
    cta_line = f"Check out {tool_name} and try it for free."
    shots.append({
        "shot": len(shots) + 1,
        "time": f"[{int(t)}-{int(t+cta_dur)}s]",
        "duration_seconds": cta_dur,
        "script_line": cta_line,
        "source": "website",
        "visual_needed": f"Call to action: Try {tool_name}",
    })
    lines.append(f"[{int(t)}-{int(t+cta_dur)}s] CTA - TRY {tool_name.upper()}\n{cta_line}\n")

    script_text = "\n".join(lines)
    (d / "script.txt").write_text(script_text, encoding="utf-8")
    (d / "shot_list.json").write_text(json.dumps(shots, indent=2, ensure_ascii=False), encoding="utf-8")

    mpath = d / "manifest.json"
    manifest = read_json(mpath) or {"tool": tool_name, "slug": slug, "status": "ok", "library": []}
    manifest["shots"] = [
        {"shot": s["shot"], "script_line": s["script_line"], "visual_needed": s["visual_needed"],
         "source": s["source"], "duration_seconds": s["duration_seconds"], "file": None}
        for s in shots
    ]
    manifest["shot_list"] = str(d / "shot_list.json")
    mpath.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    try:
        from pipeline import matcher
        matcher.match(slug, str(OUT))
    except Exception:
        pass

    return {"ok": True, "shots": shots, "script": script_text}


@app.post("/api/tool/{slug}/script/save")
def save_custom_script(slug: str, script_text: str = Form(...)):
    d = tool_dir(slug)
    text = script_text.strip()
    if not text:
        raise HTTPException(400, "Script cannot be empty.")
    (d / "script.txt").write_text(text, encoding="utf-8")

    from pipeline.matcher import parse_script
    segments = parse_script(text)
    shots = []
    if segments:
        for idx, seg in enumerate(segments, start=1):
            dur = max(2.0, seg["end"] - seg["start"]) if seg.get("end") else 4.0
            s_line = " ".join(seg.get("lines") or []) or seg.get("title") or f"Shot {idx}"
            shots.append({
                "shot": idx,
                "time": f"[{int(seg['start'])}-{int(seg['end'])}s]" if seg.get("end") else "",
                "duration_seconds": dur,
                "script_line": s_line,
                "source": seg.get("source") or "website",
                "visual_needed": seg.get("title") or f"Shot {idx}",
            })
    else:
        t = 0.0
        paras = [p.strip() for p in text.split("\n\n") if p.strip()]
        for idx, p in enumerate(paras, start=1):
            dur = 4.0
            shots.append({
                "shot": idx,
                "time": f"[{int(t)}-{int(t+dur)}s]",
                "duration_seconds": dur,
                "script_line": p,
                "source": "website",
                "visual_needed": f"Shot {idx}",
            })
            t += dur

    (d / "shot_list.json").write_text(json.dumps(shots, indent=2, ensure_ascii=False), encoding="utf-8")

    mpath = d / "manifest.json"
    manifest = read_json(mpath) or {"tool": slug, "slug": slug, "status": "ok", "library": []}
    manifest["shots"] = [
        {"shot": s["shot"], "script_line": s["script_line"], "visual_needed": s["visual_needed"],
         "source": s["source"], "duration_seconds": s["duration_seconds"], "file": None}
        for s in shots
    ]
    manifest["shot_list"] = str(d / "shot_list.json")
    mpath.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    try:
        from pipeline import matcher
        matcher.match(slug, str(OUT))
    except Exception:
        pass

    return {"ok": True, "shots": shots, "script": text}


@app.post("/api/tool/{slug}/script/generate")
def generate_ai_script(slug: str, url: str = Form("")):
    d = tool_dir(slug)
    site = read_json(d / "site_data.json") or {}
    tool_url = url or site.get("url") or f"https://{slug}.com"

    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("GROK_API_KEY") or os.environ.get("GROQ_API_KEY")):
        raise HTTPException(400, "No API key configured in .env.")

    from pipeline import matcher, script_gen
    try:
        script_gen.generate(slug, tool_url, str(OUT))
        matcher.match(slug, str(OUT))
    except Exception as e:
        raise HTTPException(500, f"AI generation error: {e}")

    return {"ok": True, "script": read_text(d / "script.txt")}


@app.post("/api/tool/{slug}/assemble")
def assemble_cut(slug: str):
    d = tool_dir(slug)
    mpath = d / "manifest.json"
    if not mpath.exists():
        raise HTTPException(400, "No manifest.json. Complete Step 1 and Step 2 first.")
    from pipeline import assembler
    try:
        path = assembler.assemble(slug, str(OUT))
        if not path or not path.exists():
            raise HTTPException(500, "Assembler produced no output.")
        return {"ok": True, "rough_cut": url_for(d, "rough_cut.mp4")}
    except Exception as e:
        raise HTTPException(500, f"Assembler error: {e}")


# ---------- page ----------

@app.get("/")
def index():
    if (ROOT / "index.html").is_file():
        return FileResponse(ROOT / "index.html", media_type="text/html; charset=utf-8")
    return FileResponse(ROOT / "web" / "pipeline.html", media_type="text/html; charset=utf-8")


@app.get("/pipeline")
def pipeline_page():
    return FileResponse(ROOT / "web" / "pipeline.html", media_type="text/html; charset=utf-8")


@app.get("/extractor")
def extractor_page():
    return FileResponse(ROOT / "web" / "index.html", media_type="text/html; charset=utf-8")


@app.exception_handler(HTTPException)
def http_error(_, exc):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=True)



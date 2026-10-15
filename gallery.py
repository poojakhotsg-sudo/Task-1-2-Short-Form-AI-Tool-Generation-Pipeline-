"""
gallery.py - the file list behind the media gallery tabs on /pipeline.

Scans out/<tool>/ for media, classifies every file by its header (not its name),
joins in what the extractor recorded (source URL, section, page order), merges
duplicates, and flags files that are probably not useful for a reel (people photos,
decorative backgrounds, icons). Works for both output formats:
    old: assets.json + assets/{images,gifs,videos}/
    new: manifest.json (a list) + gifs_videos/ + images/ + report.json
No network or AI calls; face detection is OpenCV's bundled Haar cascade.
"""

import hashlib
import json
import re
import subprocess
import threading
from pathlib import Path
from urllib.parse import quote

from PIL import Image

FACE_MODEL = Path(__file__).resolve().parent / "models" / "face_detection_yunet_2023mar.onnx"
MEDIA_DIRS = ("assets", "gifs_videos", "images", "clips")
EMBED_RE = re.compile(r"youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.(com|net)", re.I)
YT_ID_RE = re.compile(r"(?:youtube(?:-nocookie)?\.com/(?:embed/|watch\?v=|shorts/)|youtu\.be/)([\w-]{11})")
SCALE_RE = re.compile(r"[_@-]?[123]x$", re.I)  # hero_2x, hero@2x, hero-1x -> hero
HASH_SUFFIX_RE = re.compile(r"-[0-9a-f]{8}$", re.I)  # imagine_3x-77cd08e5 -> imagine_3x
ICON_RE = re.compile(r"(^|[\W_])(icons?|logos?|favicons?|sprites?|badges?|arrows?|chevrons?)([\W_]|$)", re.I)
DECOR_RE = re.compile(r"(^|[\W_])(bg|backgrounds?|patterns?|textures?|clouds?|stars?|gradients?|noise|blur|"
                      r"blobs?|shapes?|decor\w*|glow|sky|nightsky|hills?|waves?|particles?)([\W_]|$)", re.I)
PERSON_NAME_RE = re.compile(r"(^|[\W_])(avatar|headshot|testimonial|portrait|profile|team|author|speaker|"
                            r"customer|founder|ceo)([\W_]|$)", re.I)

_cache = {}  # (path, mtime, size) -> per-file facts that cost something to compute


def _ffprobe(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format",
                            str(path)], capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout or "{}")
    except Exception:
        return {}


def sniff(path):
    """Kind from the first bytes: video | gif | image | svg | None. Animation is decided by sniff_frames."""
    head = path.open("rb").read(64)
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:8] == b"\x89PNG\r\n\x1a\n" or head[:3] == b"\xff\xd8\xff" or head[:2] == b"BM":
        return "image"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        return "image" if brand in (b"avif", b"avis", b"heic", b"mif1") else "video"
    if head[:4] == b"\x1a\x45\xdf\xa3":  # Matroska / WebM
        return "video"
    text = head.lstrip().lower()
    if text.startswith((b"<svg", b"<?xml")) or path.suffix.lower() == ".svg":
        return "svg"
    if head[:4] == b"\x00\x00\x01\x00":  # .ico
        return "image"
    return None


def facts(path, kind):
    """Dimensions, frames, duration - cached per file version."""
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key in _cache:
        return _cache[key]
    f = {"width": None, "height": None, "frames": 1, "duration": None}
    if kind == "video":
        info = _ffprobe(path)
        v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
        f["width"], f["height"] = v.get("width"), v.get("height")
        dur = info.get("format", {}).get("duration") or v.get("duration")
        f["duration"] = round(float(dur), 2) if dur else None
    elif kind == "svg":
        try:
            txt = path.read_text(encoding="utf-8", errors="replace")[:4000]
            vb = re.search(r'viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', txt)
            if vb:
                f["width"], f["height"] = round(float(vb.group(1))), round(float(vb.group(2)))
        except Exception:
            pass
    else:
        try:
            with Image.open(path) as im:
                f["width"], f["height"] = im.size
                f["frames"] = getattr(im, "n_frames", 1) or 1
                if f["frames"] > 1:
                    total = 0
                    for i in range(f["frames"]):
                        im.seek(i)
                        total += im.info.get("duration", 100) or 100
                    f["duration"] = round(total / 1000, 2)
        except Exception:
            pass
    _cache[key] = f
    return f


_face_lock = threading.Lock()
_face_detector = []  # created on first use


def has_big_face(path):
    """True when a face covers a good part of the picture (a headshot, not a crowd shot).
    Uses OpenCV's YuNet model from models/ (local file, no API)."""
    st = path.stat()
    key = ("face", str(path), st.st_mtime_ns, st.st_size)
    if key in _cache:
        return _cache[key]
    found = False
    try:
        import cv2
        import numpy as np
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((400, 400))
            arr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
        h, w = arr.shape[:2]
        with _face_lock:
            if not _face_detector:
                if not FACE_MODEL.is_file():
                    return False
                _face_detector.append(cv2.FaceDetectorYN.create(str(FACE_MODEL), "", (320, 320), 0.8))
            det = _face_detector[0]
            det.setInputSize((w, h))
            _, faces = det.detect(arr)
        found = faces is not None and any(f[2] * f[3] >= 0.04 * w * h for f in faces)
    except Exception:
        pass
    _cache[key] = found
    return found


def sha256(path):
    st = path.stat()
    key = ("sha", str(path), st.st_mtime_ns, st.st_size)
    if key not in _cache:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        _cache[key] = h.hexdigest()
    return _cache[key]


def _read_json(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _public(d, rel, mtime=None):
    return f"/out/{quote(d.name)}/{quote(rel)}" + (f"?v={int(mtime)}" if mtime else "")


def _embed_thumb(url):
    m = YT_ID_RE.search(url or "")
    return f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg" if m else None


def build(d):
    """Gallery items for out/<tool>/ (d): one per card, each in exactly one tab."""
    d = Path(d)
    # ---- what the extractor recorded, keyed by path relative to d ----
    meta, embeds_link_only, derived = {}, [], set()
    old = _read_json(d / "assets.json")
    if isinstance(old, list):
        for i, a in enumerate(old):
            info = {"source_url": a.get("source_url"), "section": a.get("section"), "order": i}
            if a.get("file_path"):
                meta[Path(a["file_path"]).as_posix()] = info
            elif a.get("type") == "embed":
                embeds_link_only.append({**info, "url": a.get("source_url")})
    new = _read_json(d / "manifest.json")
    if isinstance(new, list):
        for a in new:
            meta[a["filename"]] = {"source_url": a.get("source_url"), "section": a.get("section"),
                                   "order": a.get("page_position"), "page_y": a.get("page_y")}
            if a.get("mp4"):
                derived.add(a["mp4"])  # mp4 copy of an animated WebP/APNG: the original is the card
        report = _read_json(d / "report.json") or {}
        for e in report.get("failed_embeds") or []:
            embeds_link_only.append({"url": e.get("url"), "source_url": e.get("url"), "section": None, "order": None})

    # ---- every media file on disk, classified by header ----
    items = []
    for sub in MEDIA_DIRS:
        root = d / sub
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file() or p.suffix.lower() in (".json", ".part", ".ytdl", ".html", ".txt"):
                continue
            rel = p.relative_to(d).as_posix()
            if rel in derived:
                continue
            kind = sniff(p)
            if kind is None:
                continue
            f = facts(p, kind)
            animated = kind in ("gif", "image") and f["frames"] > 1
            if kind == "image" and animated:
                kind = "gif"  # animated WebP / APNG / AVIF live with the GIFs
            m = meta.get(rel, {})
            src = m.get("source_url") or ""
            if kind == "video" and EMBED_RE.search(src):
                kind = "embed"
            st = p.stat()
            items.append({
                "id": rel, "tab": kind, "name": p.name, "url": _public(d, rel, st.st_mtime),
                "animated": animated, "format": p.suffix.lower().lstrip("."),
                "width": f["width"], "height": f["height"], "frames": f["frames"] if animated else None,
                "duration": f["duration"], "size": st.st_size, "mtime": int(st.st_mtime),
                "section": m.get("section"), "page_y": m.get("page_y"), "order": m.get("order"),
                "source_url": src or None, "downloaded": True if kind == "embed" else None,
                "thumb": _embed_thumb(src) if kind == "embed" else None, "merged": [],
            })
    for e in embeds_link_only:
        if not e.get("url") or not EMBED_RE.search(e["url"]):
            continue
        items.append({"id": "embed:" + e["url"], "tab": "embed", "name": e["url"].split("/")[-1][:60] or e["url"],
                      "url": None, "animated": False, "format": "link", "width": None, "height": None,
                      "frames": None, "duration": None, "size": 0, "mtime": 0, "section": e.get("section"),
                      "page_y": None, "order": e.get("order"), "source_url": e["url"], "downloaded": False,
                      "thumb": _embed_thumb(e["url"]), "merged": []})

    items = _merge_duplicates(d, items)
    for it in items:
        it["flags"] = _flags(d, it)
    return items


def _merge_duplicates(d, items):
    """Same bytes, or the 1x/2x/3x renditions of one picture -> one card, keeping the largest."""
    def bigness(it):
        return ((it["width"] or 0) * (it["height"] or 0), it["size"])

    def absorb(keep, gone):
        keep["merged"] += [gone["name"]] + gone["merged"]
        for k in ("order", "page_y"):
            if gone[k] is not None and (keep[k] is None or gone[k] < keep[k]):
                keep[k] = gone[k]
        keep["section"] = keep["section"] or gone["section"]

    groups = {}
    for it in items:
        key = ("sha", sha256(d / it["id"])) if it["url"] else ("id", it["id"])
        groups.setdefault(key, []).append(it)
    out = []
    for group in groups.values():
        group.sort(key=bigness, reverse=True)
        for g in group[1:]:
            absorb(group[0], g)
        out.append(group[0])

    def stem(it):
        return HASH_SUFFIX_RE.sub("", Path(it["name"]).stem).lower()

    groups = {}
    for it in out:
        if it["url"] and SCALE_RE.search(stem(it)):
            groups.setdefault((it["tab"], SCALE_RE.sub("", stem(it))), []).append(it)
    for (tab, base), group in groups.items():
        twin = next((o for o in out if o["tab"] == tab and stem(o) == base and o not in group), None)
        if twin:  # hero.png next to hero@2x.png
            group.append(twin)
        if len(group) < 2:
            continue
        group.sort(key=bigness, reverse=True)
        for g in group[1:]:
            absorb(group[0], g)
            g["gone"] = True
    return [it for it in out if not it.get("gone")]


def _flags(d, it):
    """Reasons a file is probably not useful in a reel. Empty list = likely useful."""
    flags = []
    name = Path(it["name"]).stem
    src_name = Path((it["source_url"] or "").split("?")[0]).stem
    w, h = it["width"] or 0, it["height"] or 0
    if ICON_RE.search(name) or ICON_RE.search(src_name) or (it["tab"] in ("image", "svg") and 0 < max(w, h) < 96):
        flags.append("icon")
    if it["tab"] == "image":
        if DECOR_RE.search(name) or DECOR_RE.search(src_name):
            flags.append("background")
        squareish = h and 0.7 <= w / h <= 1.35
        if PERSON_NAME_RE.search(name) or (squareish and has_big_face(d / it["id"])):
            flags.append("person")
    return flags

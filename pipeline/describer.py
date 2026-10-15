"""
describer.py - stage "describe": catalog video clips with a vision model.

Extracts 3 frames from each clip, sends them to Claude or Groq vision,
and writes out/<tool>/clip_catalog.json with captions, tags, and has_ui flag.
"""

import base64
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from dotenv import load_dotenv

from . import qa
from .grabber import slugify

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

log = logging.getLogger("describer")

VISION_PROMPT = """You are an AI video asset cataloger for short-form social media reels.
Analyze these 3 chronological frames from a video clip.
Return ONLY a valid JSON object with:
- "caption": A concise, accurate one-line description of what actually happens in the video (e.g. "man in white shirt turns into a kimono", or "user interface showing prompt box and generate button").
- "tags": Array of 2-5 keyword tags (e.g. ["outfit change", "before/after", "clothing swap"]).
- "has_ui": boolean (true if this clip shows the app interface, editor, dashboard, prompt box, or cursor; false if it only shows raw video output/demonstrations).
- "clip_type": "ui" if the clip shows the software interface, else "example_output".
"""


def _extract_frames(clip_path, tmp_dir):
    dur, w, h = qa.probe(clip_path)
    if dur <= 0:
        return []
    timestamps = [0.2 * dur, 0.5 * dur, 0.8 * dur]
    frames = []
    for i, t in enumerate(timestamps):
        out_img = Path(tmp_dir) / f"{clip_path.stem}_f{i}.jpg"
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-ss", f"{t:.2f}", "-i", str(clip_path),
            "-vframes", "1", "-vf", "scale=640:-1", "-q:v", "3",
            str(out_img)
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            if out_img.exists() and out_img.stat().st_size > 500:
                frames.append(out_img)
        except Exception as e:
            log.warning("could not extract frame at %s from %s: %s", t, clip_path.name, e)
    return frames


def _call_vision(frames, max_retries=5):
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("GROK_API_KEY")

    if anthropic_key:
        import anthropic
        client = anthropic.Anthropic(api_key=anthropic_key)
        content = [{"type": "text", "text": VISION_PROMPT}]
        for f in frames:
            data = base64.b64encode(f.read_bytes()).decode("utf-8")
            content.append({
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": data}
            })
        resp = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=500,
            messages=[{"role": "user", "content": content}]
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
    elif groq_key:
        import groq
        import time as _time
        client = groq.Groq(api_key=groq_key)
        content = [{"type": "text", "text": VISION_PROMPT}]
        for f in frames:
            data = base64.b64encode(f.read_bytes()).decode("utf-8")
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{data}"}
            })
        text = ""
        for attempt in range(max_retries):
            try:
                resp = client.chat.completions.create(
                    model="qwen/qwen3.8-27b",
                    messages=[{"role": "user", "content": content}],
                    response_format={"type": "json_object"},
                    temperature=0.2,
                )
                text = resp.choices[0].message.content or ""
                break
            except Exception as e:
                err_str = str(e)
                if "rate_limit" in err_str or "429" in err_str:
                    wait = 2 ** attempt * 3  # 3s, 6s, 12s, 24s, 48s
                    log.warning("Groq rate limit hit, waiting %ds (attempt %d/%d)", wait, attempt + 1, max_retries)
                    _time.sleep(wait)
                    if attempt == max_retries - 1:
                        raise
                else:
                    raise
    else:
        raise RuntimeError("No API key available for vision: set GROQ_API_KEY or ANTHROPIC_API_KEY in .env")

    # Parse response
    try:
        # Strip potential markdown formatting
        clean_text = re.sub(r"^```(?:json)?\s*", "", text.strip())
        clean_text = re.sub(r"\s*```$", "", clean_text)
        return json.loads(clean_text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise ValueError(f"Could not parse vision JSON: {text[:200]}")


def describe(tool, out_root="out"):
    """Describe every clip in out/<tool>/clips/ and write out/<tool>/clip_catalog.json."""
    slug = slugify(tool)
    tool_dir = Path(out_root) / slug
    clips_dir = tool_dir / "clips"
    catalog_path = tool_dir / "clip_catalog.json"

    if not clips_dir.exists():
        raise RuntimeError(f"Clips directory {clips_dir} not found. Run grab stage first.")

    # Load existing catalog for caching
    existing = {}
    if catalog_path.exists():
        try:
            for item in json.loads(catalog_path.read_text(encoding="utf-8")):
                if isinstance(item, dict) and item.get("file"):
                    existing[item["file"]] = item
        except Exception:
            pass

    # Find all clips to describe
    all_clips = sorted(clips_dir.glob("*.mp4"))
    # Prefer segmented clips over raw ones if segs exist
    seg_stems = {c.stem.split("_seg")[0] for c in all_clips if "_seg" in c.stem}
    target_clips = []
    for c in all_clips:
        if c.stem.startswith("shot") and not c.stem.endswith("_manual"):
            continue  # ignore old shot cutouts if any
        if c.stem in seg_stems:
            continue  # skip raw long video if segment clips exist
        target_clips.append(c)

    log.info("found %d clips to catalog in %s", len(target_clips), clips_dir)
    catalog = []
    with tempfile.TemporaryDirectory() as tmp_dir:
        for c in target_clips:
            rel = f"clips/{c.name}"
            if rel in existing and existing[rel].get("caption"):
                catalog.append(existing[rel])
                continue

            dur, _, _ = qa.probe(c)
            frames = _extract_frames(c, tmp_dir)
            if not frames:
                catalog.append({
                    "file": rel,
                    "caption": f"Clip {c.stem}",
                    "tags": ["clip"],
                    "has_ui": False,
                    "clip_type": "example_output",
                    "seconds": round(dur, 1)
                })
                continue

            try:
                info = _call_vision(frames)
                entry = {
                    "file": rel,
                    "caption": info.get("caption") or f"Clip {c.stem}",
                    "tags": info.get("tags") or ["clip"],
                    "has_ui": bool(info.get("has_ui", False)),
                    "clip_type": info.get("clip_type") or ("ui" if info.get("has_ui") else "example_output"),
                    "seconds": round(dur, 1)
                }
            except Exception as e:
                log.warning("vision failed for %s: %s", c.name, e)
                entry = {
                    "file": rel,
                    "caption": f"Clip {c.stem}",
                    "tags": ["clip"],
                    "has_ui": False,
                    "clip_type": "example_output",
                    "seconds": round(dur, 1)
                }
            catalog.append(entry)
            time.sleep(2)  # stay under Groq ITPM rate limit

    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("wrote %d entries to %s", len(catalog), catalog_path)
    return catalog

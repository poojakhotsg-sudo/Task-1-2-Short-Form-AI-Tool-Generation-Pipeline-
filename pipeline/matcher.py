"""
matcher.py - stage "match": build the shot list from script.txt and match clips to it.

1. Parse out/<tool>/script.txt into segments: lines like
       [4-14s]  FEATURE 1 - PROMPT TO DECK
       One: type what you need...
   become {label: "STEP 1", title: "Prompt to deck", start: 4, end: 14, script_line: "One: ..."}.
   Labels: HOOK, STEP n (from FEATURE/STEP/PART/SHOT n), PROOF, CTA.
2. One shot per segment. Source is "trial" for proof/own-test segments (or per
   shot_list.json when it lines up), else "website".
3. Each website shot gets the best recorded section clip from manifest["library"],
   scored by keyword overlap with the clip's section heading and text. Each clip is
   used at most once; shots with no good match become "missing".

Clips a person uploaded or chose, and trial recordings, are kept across runs.
Run: python -m pipeline.matcher gamma [out_root]
"""

import json
import math
import os
import re
import sys
from pathlib import Path

from . import qa
from .grabber import _tokens

HEADER_RE = re.compile(r"^\s*\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–]\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*(.*)$")
STEP_RE = re.compile(r"^(?:feature|step|part|point|f|shot|beat)\s*#?\s*(\d+)$", re.I)
KEEP_LABELS = {"HOOK", "PROOF", "CTA", "INTRO", "OUTRO", "DEMO", "RESULT"}
TRIAL_HINT = re.compile(r"\b(proof|my own|our own|own test|for me|i (built|made|tried|tested|asked)|"
                        r"here'?s (the|what) it (built|made)|watch (it|this) (build|make))\b", re.I)
MIN_SCORE = 0.9       # below this a match is treated as "no match"
STRONG_SCORE = 1.5    # ...and a single shared keyword needs at least this much
# Script filler that says nothing about which part of the page to show.
FILLER = set("""what any all how who why when where here there more most every new make made build built get
like need want just also same save next one two three four five first second third done thing things way
lot really even every own way back now see watch try free""".split())
# Sections that repeat the whole site's vocabulary but make poor footage.
WEAK_SECTION = re.compile(r"\b(faq|frequently asked|questions|footer|cookie|newsletter|sign ?up)\b", re.I)
FAIL_WEIGHT = 0.6     # clips that failed QA rank below passing ones with the same keywords


# ---------- parse the script ----------

def parse_script(text):
    """Return segments [{label, title, start, end, script_line, source}] in script order."""
    segments, cur = [], None
    for raw in text.splitlines():
        m = HEADER_RE.match(raw)
        if m:
            start, end, rest = float(m.group(1)), float(m.group(2)), m.group(3).strip()
            src = re.search(r"\((website|trial)\)", rest, re.I)
            rest = re.sub(r"\((website|trial)\)", "", rest, flags=re.I).strip()
            head, _, title = (p.strip() for p in rest.partition(" - "))
            cur = {"head": head, "title": title.capitalize() if title.isupper() else title,
                   "start": start, "end": end, "lines": [], "source": src.group(1).lower() if src else None}
            segments.append(cur)
        elif cur is not None and raw.strip():
            cur["lines"].append(raw.strip())

    out, step = [], 0
    for i, s in enumerate(segments):
        head = s["head"].upper()
        line = " ".join(s["lines"])
        m = STEP_RE.match(s["head"])
        if head in KEEP_LABELS:
            label = head
        elif m and not head.startswith("SHOT"):
            label = f"STEP {int(m.group(1))}"
        else:  # "SHOT 3" or a free-form header: name it by position/role
            label = ("HOOK" if i == 0 else "CTA" if i == len(segments) - 1 and len(segments) > 1
                     else "PROOF" if (s["source"] == "trial" or TRIAL_HINT.search(line)) else None)
            if not s["title"] and s["head"] and not STEP_RE.match(s["head"]):
                s["title"] = s["head"].capitalize() if s["head"].isupper() else s["head"]
        if label is None:
            step += 1
            label = f"STEP {step}"
        elif label.startswith("STEP"):
            step = int(label.split()[1])
        source = s["source"] or ("trial" if label == "PROOF" or TRIAL_HINT.search(line) else "website")
        out.append({"label": label, "title": s["title"], "start": s["start"], "end": s["end"],
                    "script_line": line, "source": source, "source_given": s["source"] is not None})
    return out


def _fmt(sec):
    return f"{sec:g}"


def build_shots(segments, shot_list=None):
    """One shot per segment or directly from shot_list.json."""
    if shot_list and isinstance(shot_list, list):
        shots = []
        for s in shot_list:
            shot_no = int(s.get("shot", len(shots) + 1))
            shots.append({
                "shot": shot_no,
                "label": f"SHOT {shot_no}",
                "title": s.get("visual_needed", ""),
                "time": s.get("time") or f"{s.get('duration_seconds', 5):g}s",
                "start": 0.0,
                "end": float(s.get("duration_seconds", 5.0)),
                "duration_seconds": float(s.get("duration_seconds", 5.0)),
                "script_line": s.get("script_line", ""),
                "source": s.get("source", "website"),
                "clip_file": s.get("clip_file"),
                "visual_needed": s.get("visual_needed", ""),
                "trial_steps": s.get("trial_steps") or [],
                "file": None,
                "match_score": 0.0,
            })
        return shots

    aligned = shot_list if shot_list and len(shot_list) == len(segments) else None
    shots = []
    for i, seg in enumerate(segments):
        extra = aligned[i] if aligned else {}
        source = seg["source"]
        if not seg.get("source_given") and extra.get("source") in ("website", "trial"):
            source = extra["source"]
        shots.append({
            "shot": i + 1, "label": seg["label"], "title": seg["title"],
            "start": seg["start"], "end": seg["end"], "time": f"{_fmt(seg['start'])}-{_fmt(seg['end'])}s",
            "duration_seconds": round(seg["end"] - seg["start"], 2),
            "script_line": seg["script_line"], "source": source,
            "clip_file": extra.get("clip_file"),
            "visual_needed": extra.get("visual_needed") or seg["title"] or "",
            "trial_steps": extra.get("trial_steps") or [],
            "file": None,
            "match_score": 0.0,
        })
    return shots


def score_catalog_with_llm(script_line, catalog):
    """Score every catalog caption against script_line using the LLM/vision model. Returns {file: score}."""
    if not catalog:
        return {}
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("GROK_API_KEY")

    prompt = (
        f"Voiceover line: \"{script_line}\"\n\n"
        f"Rate how well each clip's visual content illustrates this voiceover line on a scale from 0.0 to 1.0 (1.0 = perfect match, 0.0 = completely irrelevant):\n"
        + json.dumps([{"file": c["file"], "caption": c.get("caption", ""), "tags": c.get("tags", [])} for c in catalog], indent=2)
        + "\n\nReturn ONLY a JSON object: {\"matches\": [{\"file\": \"...\", \"score\": 0.85}, ...]}"
    )

    text = ""
    try:
        if anthropic_key:
            import anthropic
            client = anthropic.Anthropic(api_key=anthropic_key)
            resp = client.messages.create(
                model="claude-3-5-sonnet-20241022",
                max_tokens=1000,
                messages=[{"role": "user", "content": prompt}]
            )
            text = "".join(b.text for b in resp.content if b.type == "text")
        elif groq_key:
            import groq
            client = groq.Groq(api_key=groq_key)
            resp = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=0.2,
            )
            text = resp.choices[0].message.content or ""
    except Exception as e:
        return {}

    scores = {}
    try:
        clean = re.sub(r"^```(?:json)?\s*", "", text.strip())
        clean = re.sub(r"\s*```$", "", clean)
        data = json.loads(clean)
        for m in data.get("matches", []):
            if "file" in m and "score" in m:
                scores[m["file"]] = float(m["score"])
    except Exception:
        pass
    return scores


def match(tool, out_root="out", url=None, headed=False):
    """Asset-first match: process each shot individually, extract relevant site clips,
    prioritize mobile UI visuals, and clearly report missing clips."""
    from . import grabber
    slug = grabber.slugify(tool)
    tool_dir = Path(out_root) / slug
    mpath = tool_dir / "manifest.json"
    if not mpath.exists():
        raise RuntimeError(f"manifest.json not found in {tool_dir} (grab stage must run first)")

    try:
        manifest = json.loads(mpath.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise RuntimeError(f"could not read manifest.json: {e}")

    shot_list_path = tool_dir / "shot_list.json"
    if not shot_list_path.exists():
        raise RuntimeError(f"shot_list.json not found in {tool_dir} (script stage must run first)")

    try:
        shot_list = json.loads(shot_list_path.read_text(encoding="utf-8"))
        if not isinstance(shot_list, list):
            raise ValueError("shot_list.json is not a list")
    except Exception as e:
        raise RuntimeError(f"could not parse shot_list.json: {e}")

    # Load clip catalog
    catalog = []
    cat_path = tool_dir / "clip_catalog.json"
    if cat_path.exists():
        try:
            catalog = json.loads(cat_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    script_path = tool_dir / "script.txt"
    segments = parse_script(script_path.read_text(encoding="utf-8", errors="replace")) if script_path.exists() else []

    shots = build_shots(segments, shot_list)
    kept = {s["shot"]: s for s in manifest.get("shots", [])
            if s.get("status") in ("manual", "recorded") and s.get("file") and (tool_dir / s["file"]).exists()}

    MIN_CONFIDENCE = 0.5
    used_files = set()

    for s in shots:
        prev = kept.get(s["shot"])
        if prev:
            s.update({k: prev[k] for k in ("file", "status", "screenshot", "seconds", "matched", "qa",
                                            "qa_reasons", "qa_metrics", "match_score") if k in prev})
            if s.get("file"):
                used_files.add(s["file"])
            continue

        if s.get("source") == "trial":
            s.update(status="needs_trial", file=None, match_score=0.0,
                     error="trial shot: needs recording inside tool (manual trial-recording fallback)")
            continue

        # Rule 1: if shot already has clip_file from asset-first script, link it
        clip_req = s.get("clip_file")
        if clip_req:
            p_req = tool_dir / clip_req
            if not p_req.exists():
                p_req = tool_dir / "clips" / Path(clip_req).name
            if p_req.exists():
                rel = str(p_req.relative_to(tool_dir)).replace("\\", "/")
                s.update(file=rel, status="ok", match_score=1.0,
                         matched={"clip": rel, "score": 1.0, "type": "script_specified"})
                used_files.add(rel)
                continue

        # Rule 1b: a per-shot clip grab already recorded for this exact shot (the name carries
        # the visual, so a clip left from an older script with a different visual isn't reused)
        if s.get("visual_needed") and (tool_dir / "clips" / grabber.clip_name(s)).is_file():
            rel = f"clips/{grabber.clip_name(s)}"
            s.update(file=rel, status="ok", match_score=1.0,
                     matched={"clip": rel, "score": 1.0, "type": "per_shot_clip"})
            used_files.add(rel)
            continue

        # Rule 2: score catalog clips with vision model / LLM
        scores = score_catalog_with_llm(s["script_line"], catalog)
        available = [(f, sc) for f, sc in scores.items() if (tool_dir / f).exists() and f not in used_files]
        available.sort(key=lambda x: -x[1])

        best_match = None
        for f, sc in available:
            if sc >= MIN_CONFIDENCE:
                best_match = (f, sc)
                break

        if best_match:
            f, sc = best_match
            s.update(file=f, status="ok", match_score=round(sc, 2),
                     matched={"clip": f, "score": round(sc, 2), "type": "vision_score"})
            used_files.add(f)
            continue

        # Rule 3: check site videos / library clips by keyword matching
        words = set(re.findall(r"\w+", (s.get("visual_needed", "") + " " + s.get("script_line", "")).lower()))
        best_lib = None
        best_overlap = 0
        for entry in manifest.get("library", []):
            f = entry.get("file")
            if not f or not (tool_dir / f).exists() or f in used_files:
                continue
            entry_words = set(re.findall(r"\w+", (entry.get("section", "") + " " + entry.get("text", "")).lower()))
            overlap = len(words & entry_words)
            if overlap > best_overlap and overlap >= 2:
                best_overlap = overlap
                best_lib = f

        if best_lib:
            s.update(file=best_lib, status="ok", match_score=round(min(1.0, 0.4 + best_overlap * 0.15), 2),
                     matched={"clip": best_lib, "score": round(min(1.0, 0.4 + best_overlap * 0.15), 2), "type": "keyword_match"})
            used_files.add(best_lib)
            continue

    # Attempt mobile per-shot recording for any pending website shots
    site_url = url or manifest.get("url")
    pending_website = [s for s in shots if s.get("source") == "website" and not s.get("file")]
    if pending_website and site_url:
        try:
            grabber.record_missing_shot_clips(site_url, tool_dir, shots, headed=headed)
        except Exception as e:
            print(f"  [warn] per-shot recording exception: {e}")

    # Mark any shots that still lack clips as missing (no silent catalog fallback)
    for s in shots:
        if s.get("source") == "website" and not s.get("file"):
            s.update(file=None, status="missing", match_score=0.0,
                     error=f"insufficient website assets for visual: '{s.get('visual_needed') or s.get('script_line')}'")

    manifest["shots"] = shots
    matched_count = sum(bool(s.get("file")) for s in shots)
    manifest["match"] = {
        "ok": True,
        "segments": len(shots),
        "clips_available": len(catalog),
        "matched": matched_count
    }
    _save(manifest, mpath, tool_dir)
    return manifest


def _save(manifest, mpath, tool_dir):
    qa.refresh_clip_map(manifest, tool_dir)
    tmp = mpath.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, mpath)


def print_match(m):
    note = m.get("match", {})
    if not note.get("ok"):
        print(f"no shots: {note.get('note')}")
        return
    for s in m["shots"]:
        got = (s.get("matched") or {}).get("section") or ""
        state = "OK" if s.get("file") else s.get("status", "").upper()
        print(f"  {s['shot']:>2} {s['time']:>8} {s['label']:<7} {state:<11} {got[:40]:<40} {s['script_line'][:50]}")
    print(f"{note['matched']} website shots matched from {note['clips_available']} clips")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m pipeline.matcher <tool> [out_root]")
    print_match(match(sys.argv[1], *sys.argv[2:3]))

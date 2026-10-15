"""
qa.py - stage 3: check every shot clip in out/<tool>/manifest.json.

A good clip is 3-15s, exactly 1080x1920, sharp, not blank, and has movement.
Each shot gets "qa": "pass"/"fail" and "qa_reasons" written back into
manifest.json, plus a top-level "clips" map (shot number -> file, status
pass/fail/missing, reason) and a "needs_trial" list of shot numbers that still
need recording in the trial (no clip yet, or the clip failed QA).
Also writes out/<tool>/qa_report.json for the web UI.

Run: python -m pipeline.qa pomelli [out_root]
"""

import json
import os
import subprocess
from pathlib import Path

import cv2
import numpy as np

MIN_S, MAX_S = 3.0, 15.0
WIDTH, HEIGHT = 1080, 1920
SHARPNESS_MIN = 500.0  # median Laplacian variance at 360px wide; lower = blurry.
                       # Calibrated: good clips 1200-9700, 4x-upscaled 780, gaussian blur 320.
BLANK_STD_MAX = 8.0    # grey-level std dev; lower = flat/black frame
MOTION_MIN = 1.0       # mean abs diff between sampled frames; lower = static pair
SAMPLES = 12


def probe(path):
    """Duration and size from ffprobe. Returns (seconds, width, height)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(out.stdout)
    stream = info["streams"][0]
    return float(info["format"]["duration"]), int(stream["width"]), int(stream["height"])


def frame_stats(path, samples=SAMPLES):
    """Sharpness, blank and motion from evenly spaced frames, via OpenCV."""
    cap = cv2.VideoCapture(str(path))
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    sharp, blank, motion, prev = [], 0, [], None
    for idx in np.linspace(0, max(frames - 1, 0), samples).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()
        if not ok:
            continue
        h, w = frame.shape[:2]
        grey = cv2.cvtColor(cv2.resize(frame, (360, int(360 * h / w))), cv2.COLOR_BGR2GRAY)
        sharp.append(cv2.Laplacian(grey, cv2.CV_64F).var())
        blank += grey.std() < BLANK_STD_MAX
        if prev is not None:
            motion.append(float(np.mean(cv2.absdiff(grey, prev))))
        prev = grey
    cap.release()
    return sharp, blank, motion


def check_clip(path):
    """Return (metrics, reasons). Empty reasons means the clip passes."""
    try:
        seconds, w, h = probe(path)
    except (subprocess.CalledProcessError, KeyError, IndexError, ValueError) as e:
        return {}, [f"unreadable video ({type(e).__name__})"]
    sharp, blank, motion = frame_stats(path)

    reasons = []
    if not (MIN_S <= seconds <= MAX_S):
        reasons.append(f"length {seconds:.1f}s (want {MIN_S:.0f}-{MAX_S:.0f}s)")
    if (w, h) != (WIDTH, HEIGHT):
        reasons.append(f"resolution {w}x{h} (want {WIDTH}x{HEIGHT})")
    if not sharp:
        reasons.append("no decodable frames")
    else:
        if np.median(sharp) < SHARPNESS_MIN:
            reasons.append(f"blurry (sharpness {np.median(sharp):.0f}, want >= {SHARPNESS_MIN:.0f})")
        if blank > len(sharp) / 2:
            reasons.append(f"mostly blank ({blank}/{len(sharp)} frames flat)")
        static = sum(m < MOTION_MIN for m in motion)
        if motion and static > len(motion) / 2:
            reasons.append(f"mostly static ({static}/{len(motion)} frame pairs unchanged)")

    metrics = {
        "seconds": round(seconds, 1), "size": f"{w}x{h}",
        "sharpness": round(float(np.median(sharp)), 1) if sharp else None,
        "motion": round(float(np.mean(motion)), 2) if motion else None,
    }
    return metrics, reasons


def annotate(manifest, tool_dir):
    """Check every shot's clip; set its qa fields, plus manifest["needs_trial"] and manifest["clips"].
    Returns the qa_report rows."""
    report = []
    for shot in manifest["shots"]:
        clip = tool_dir / shot["file"] if shot.get("file") else None
        if clip is None:
            metrics, reasons = {}, ["no clip yet"]
        elif not clip.exists():
            metrics, reasons = {}, [f"clip missing on disk ({shot['file']})"]
        else:
            metrics, reasons = check_clip(clip)
        shot["qa"] = "fail" if reasons else "pass"
        shot["qa_reasons"] = reasons
        shot["qa_metrics"] = metrics
        if clip is not None:
            report.append({"file": clip.name, **metrics, "ok": not reasons, "issues": reasons})
    refresh_clip_map(manifest, tool_dir)
    return report


def refresh_clip_map(manifest, tool_dir):
    """manifest["clips"]: shot number -> {file, status: pass|fail|missing, reason}, from the shots' qa fields."""
    clips = {}
    for s in sorted(manifest["shots"], key=lambda s: s["shot"]):
        has_file = bool(s.get("file")) and (tool_dir / s["file"]).exists()
        if not has_file:
            status = "missing"
            reason = s.get("trial_error") or s.get("error") or (
                f"clip missing on disk ({s['file']})" if s.get("file") else
                "needs trial recording" if s.get("source") == "trial" else "not recorded")
        elif s.get("status") == "manual":  # a person picked this clip; QA notes are advisory
            notes = "; ".join(s.get("qa_reasons") or [])
            status, reason = "pass", f"manual upload (QA notes: {notes})" if notes else "manual upload"
        elif s.get("qa") == "pass":
            status, reason = "pass", ""
        elif s.get("qa") == "fail":
            status, reason = "fail", "; ".join(s.get("qa_reasons") or [])
        else:
            status, reason = "fail", "not checked by QA yet"
        if s.get("status") == "needs_manual" and s.get("trial_error") and s["trial_error"] not in reason:
            reason = f"{reason}; needs manual: {s['trial_error']}" if reason else f"needs manual: {s['trial_error']}"
        clips[str(s["shot"])] = {"file": s.get("file") if has_file else None, "status": status, "reason": reason}
    manifest["clips"] = clips
    manifest["needs_trial"] = [int(k) for k, v in clips.items() if v["status"] != "pass"]
    return clips


def annotate_library(manifest, tool_dir):
    """Re-check the grabber's section clips (manifest["library"]), keeping retry notes."""
    report = []
    for c in manifest.get("library", []):
        if not c.get("file") or not (tool_dir / c["file"]).exists():
            continue
        metrics, reasons = check_clip(tool_dir / c["file"])
        notes = [r for r in c.get("qa_reasons", []) if r.startswith("still static after")]
        c.update(qa="fail" if reasons else "pass", qa_reasons=reasons + (notes if reasons else []), qa_metrics=metrics)
        report.append({"file": Path(c["file"]).name, **metrics, "ok": not reasons, "issues": reasons})
    return report


def run_qa(tool, out_root="out"):
    tool_dir = Path(out_root) / tool
    manifest_path = tool_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lib_report = annotate_library(manifest, tool_dir)
    by_file = {c["file"]: c for c in manifest.get("library", []) if c.get("file")}
    for s in manifest["shots"]:  # shots matched to a library clip share its result
        if s.get("file") in by_file and s.get("status") not in ("manual", "recorded"):
            c = by_file[s["file"]]
            s.update(qa=c["qa"], qa_reasons=c["qa_reasons"], qa_metrics=c["qa_metrics"])
    report = annotate(manifest, tool_dir)
    report += [r for r in lib_report if r["file"] not in {x["file"] for x in report}]

    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, manifest_path)
    (tool_dir / "qa_report.json").write_text(json.dumps(report, indent=2))
    return manifest


def print_report(manifest):
    for s in manifest["shots"]:
        mark = "PASS" if s["qa"] == "pass" else "FAIL"
        print(f"  {mark} shot {s['shot']:>2}  " + "; ".join(s["qa_reasons"]))
    shots = manifest["shots"]
    print(f"{sum(s['qa'] == 'pass' for s in shots)}/{len(shots)} shots pass QA")
    todo = [s for s in shots if s["qa"] == "fail"]
    if not todo:
        print("No shots need trial recording.")
        return
    print("Still need trial recording:")
    for s in todo:
        print(f"  shot {s['shot']}: {s['visual_needed']}  [{'; '.join(s['qa_reasons'])}]")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        sys.exit("usage: python -m pipeline.qa <tool> [out_root]")
    print_report(run_qa(sys.argv[1], *sys.argv[2:3]))

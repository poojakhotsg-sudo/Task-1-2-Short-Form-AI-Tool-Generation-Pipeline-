"""
assembler.py - stage 5: cut the shots into a rough cut, in shot order.

Reads out/<tool>/manifest.json, trims each clip to its shot's duration_seconds
(from shot_list.json), and joins them into out/<tool>/rough_cut.mp4 (1080x1920).
Shots with no clip get a black placeholder card for their duration so the cut
keeps the script's timing. Also writes out/<tool>/summary.md.

Run: python -m pipeline.assembler gamma [out_root] [--no-placeholders]
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from .grabber import H, W
from .qa import probe

FPS = 30
DEFAULT_PLACEHOLDER_S = 3.0
FONT = Path("C:/Windows/Fonts/arial.ttf")
ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
          "-r", str(FPS), "-an"]


def load_durations(manifest, tool_dir):
    """shot number -> duration_seconds: the script's time ranges (in the manifest) first, then shot_list.json."""
    path = Path(manifest["shot_list"]) if manifest.get("shot_list") else None
    if not (path and path.exists()):
        path = tool_dir / "shot_list.json"
    durations = {s["shot"]: float(s["duration_seconds"]) for s in manifest["shots"] if s.get("duration_seconds")}
    if path.exists():
        for s in json.loads(path.read_text(encoding="utf-8")):
            if s.get("duration_seconds"):
                durations.setdefault(s["shot"], float(s["duration_seconds"]))
    return durations


def _ffmpeg(args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True, capture_output=True, timeout=300)


def trim_clip(src, out, want, from_end):
    """Re-encode `want` seconds of src to 1080x1920@30. Trial clips keep their end (the result)."""
    length = probe(src)[0]
    take = min(want, length) if want else length
    start = max(0.0, length - take) if from_end else 0.0
    vf = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    _ffmpeg(["-ss", f"{start:.2f}", "-i", str(src), "-t", f"{take:.2f}", "-vf", vf, *ENCODE, str(out)])
    return take, length


def placeholder(out, seconds, label):
    vf = "null"
    if FONT.exists():
        text = label.replace("\\", "").replace(":", r"\:").replace("'", "")
        font = str(FONT).replace("\\", "/").replace(":", r"\:")
        vf = (f"drawtext=fontfile='{font}':text='{text}':fontcolor=white:fontsize=64:"
              f"x=(w-text_w)/2:y=(h-text_h)/2")
    _ffmpeg(["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={FPS}:d={seconds:.2f}",
             "-vf", vf, *ENCODE, str(out)])


def classify(shot, tool_dir):
    has_clip = bool(shot.get("file")) and (tool_dir / shot["file"]).exists()
    if shot.get("status") == "needs_manual":
        return "needs_manual", has_clip
    return ("covered" if has_clip else "missing"), has_clip


def assemble(tool, out_root="out", placeholders=True):
    """Write rough_cut.mp4 and summary.md. Returns the rough cut path (None if nothing to cut)."""
    tool_dir = Path(out_root) / tool
    manifest = json.loads((tool_dir / "manifest.json").read_text(encoding="utf-8"))
    durations = load_durations(manifest, tool_dir)
    shots = sorted(manifest["shots"], key=lambda s: s["shot"])

    rows, t = [], 0.0
    out = tool_dir / "rough_cut.mp4"
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for s in shots:
            kind, has_clip = classify(s, tool_dir)
            want = durations.get(s["shot"])
            seg = Path(tmp) / f"seg{s['shot']:03d}.mp4"
            row = {"shot": s, "kind": kind, "want": want, "start": t, "note": ""}
            if has_clip:
                take, length = trim_clip(tool_dir / s["file"], seg, want, from_end=s.get("source") == "trial")
                row["used"] = f"clip ({take:.1f}s)"
                if want is None:
                    row["note"] = f"no duration_seconds, used full {length:.1f}s clip"
                elif length < want:
                    row["note"] = f"clip only {length:.1f}s, wanted {want:g}s"
            elif placeholders:
                take = want or DEFAULT_PLACEHOLDER_S
                placeholder(seg, take, f"SHOT {s['shot']} MISSING")
                row["used"] = f"placeholder ({take:.1f}s)"
            else:
                rows.append({**row, "used": "left out", "start": None})
                continue
            parts.append(seg)
            t += take
            rows.append(row)

        if parts:
            concat = Path(tmp) / "concat.txt"
            concat.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
            _ffmpeg(["-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy",
                     "-movflags", "+faststart", str(out)])
        elif out.exists():
            out.unlink()

    (tool_dir / "summary.md").write_text(render_summary(manifest, rows, t, out if parts else None),
                                         encoding="utf-8")
    return out if parts else None


def _ts(sec):
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def render_summary(manifest, rows, total, cut):
    def line(r):
        s = r["shot"]
        at = _ts(r["start"]) if r["start"] is not None else "-"
        want = f"{r['want']:g}s" if r["want"] else "-"
        return (f"| {s['shot']} | {at} | {want} | {r['used']} | {s.get('source') or '-'} | "
                f"{(s.get('visual_needed') or '').replace('|', '/')} | {r['note']} |")

    head = "| Shot | At | Target | In cut | Source | Visual | Note |\n|---|---|---|---|---|---|---|"
    groups = {k: [r for r in rows if r["kind"] == k] for k in ("covered", "missing", "needs_manual")}
    out = [f"# {manifest['tool']} rough cut", "",
           f"- Rough cut: `{cut.name}` ({_ts(total)}, {W}x{H})" if cut else "- Rough cut: not made (no shots to cut)",
           f"- Shots: {len(rows)} total, {len(groups['covered'])} covered, "
           f"{len(groups['missing'])} missing, {len(groups['needs_manual'])} needs manual", ""]

    out += [f"## Covered ({len(groups['covered'])})", ""]
    out += [head, *map(line, groups["covered"])] if groups["covered"] else ["None."]
    qa_fails = [r["shot"] for r in groups["covered"] if r["shot"].get("qa") == "fail"]
    if qa_fails:
        out += ["", "Covered but failed QA (in the cut, should be replaced):"]
        out += [f"- Shot {s['shot']}: {'; '.join(s.get('qa_reasons') or [])}" for s in qa_fails]

    out += ["", f"## Missing ({len(groups['missing'])})", ""]
    out += [head, *map(line, groups["missing"])] if groups["missing"] else ["None."]

    out += ["", f"## Needs manual ({len(groups['needs_manual'])})", ""]
    if groups["needs_manual"]:
        out += [head, *map(line, groups["needs_manual"]), ""]
        out += [f"- Shot {r['shot']['shot']}: {r['shot'].get('trial_error') or 'flagged needs manual'}"
                for r in groups["needs_manual"]]
    else:
        out += ["None."]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("usage: python -m pipeline.assembler <tool> [out_root] [--no-placeholders]")
    path = assemble(args[0], *args[1:2], placeholders="--no-placeholders" not in sys.argv)
    print(f"Saved {path}" if path else "Nothing to cut.")
    print(f"Saved {Path(*args[1:2] or ['out']) / args[0] / 'summary.md'}")

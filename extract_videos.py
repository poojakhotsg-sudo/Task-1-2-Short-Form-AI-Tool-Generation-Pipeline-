#!/usr/bin/env python3
"""
extract_videos.py - standalone runner for the demo-video extraction step.

Usage:
    python extract_videos.py gamma https://gamma.app
    python extract_videos.py pomelli https://labs.google.com/pomelli
    python extract_videos.py gamma https://gamma.app --headed --out reel-pipeline/out

Reads shot_list.json (if present in out/<tool>/) to use per-shot duration_seconds
for trimming. Outputs named clips (hero.mp4, use_case_1.mp4, ...) and writes a
video_extraction.log + video_extraction.json to the tool's output folder.
"""

import argparse
import json
import sys
from pathlib import Path

# Allow running from both the project root and from inside reel-pipeline/
_root = Path(__file__).resolve().parent
sys.path.insert(0, str(_root))

from pipeline.grabber import extract_demo_videos, slugify


def main():
    ap = argparse.ArgumentParser(description="Extract demo videos from a tool website.")
    ap.add_argument("tool", help="Tool name, e.g. gamma")
    ap.add_argument("url", help="Tool website URL")
    ap.add_argument("--out", default="out", help="Output root directory (default: out)")
    ap.add_argument("--headed", action="store_true", help="Show browser windows")
    args = ap.parse_args()

    out_root = Path(args.out)
    tool_slug = slugify(args.tool)
    tool_dir = out_root / tool_slug

    # Load shot_list.json if available to get per-shot duration_seconds
    shot_list = None
    shot_list_path = tool_dir / "shot_list.json"
    if shot_list_path.exists():
        try:
            shot_list = json.loads(shot_list_path.read_text(encoding="utf-8"))
            print(f"  Loaded {len(shot_list)} shots from shot_list.json")
        except Exception as e:
            print(f"  Warning: could not read shot_list.json: {e}")
    else:
        print(f"  No shot_list.json found at {shot_list_path} - using default clip duration")

    print(f"\n>>> Extracting demo videos for {args.tool} from {args.url}")
    results = extract_demo_videos(
        url=args.url,
        tool=args.tool,
        out_root=str(out_root),
        shot_list=shot_list,
        headed=args.headed,
    )

    print(f"\n{'='*60}")
    print(f"Video extraction results for: {args.tool}")
    print(f"{'='*60}")
    if not results:
        print("  (no videos or embeds found)")
    else:
        for r in results:
            mark = "OK  " if r["status"] == "ok" else "FAIL"
            print(f"  [{mark}] {r['section']:<16}  {r['file']:<36}  "
                  f"type={r['type']:<18}  target={r['duration_s']:.1f}s")
            print(f"         source: {r['source'][:80]}")

    ok = sum(1 for r in results if r["status"] == "ok")
    log_path = tool_dir / "video_extraction.log"
    json_path = tool_dir / "video_extraction.json"
    print(f"\n  {ok}/{len(results)} clips extracted successfully")
    print(f"  Log:  {log_path}")
    print(f"  JSON: {json_path}")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())

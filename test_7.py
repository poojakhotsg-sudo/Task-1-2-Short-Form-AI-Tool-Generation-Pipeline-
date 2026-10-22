import sys
import csv
import json
import re
import argparse
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from extract_assets import extract, get_next_output_dir

TOOLS = [
    ("Pomelli Visual Gen", "https://labs.google.com/pomelli"),
    ("Notion", "https://www.notion.so"),
    ("Canva", "https://www.canva.com"),
    ("Gamma", "https://gamma.app"),
    ("Runway", "https://runwayml.com"),
    ("Framer", "https://www.framer.com"),
    ("Genspark", "https://www.genspark.ai"),
]

OUTPUT_DIR = ROOT / "output"
CSV_PATH = ROOT / "results.csv"


def find_tool_dir(name):
    """Find existing numbered directory in output/ for tool name."""
    if not OUTPUT_DIR.exists():
        return None
    for p in OUTPUT_DIR.iterdir():
        if p.is_dir():
            m = re.match(r"^\d+\s*-\s*(.+)$", p.name)
            if m and m.group(1).strip().lower() == name.strip().lower():
                return p
    return None


def run_tests(force=False):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []

    for name, url in TOOLS:
        print(f"\n{'='*65}\n  TOOL: {name} ({url})\n{'='*65}")
        target_dir = find_tool_dir(name)
        mf_path = target_dir / "manifest.json" if target_dir else None
        rp_path = target_dir / "report.json" if target_dir else None

        if target_dir and mf_path.exists() and not force:
            print(f"Skipping {name}: manifest.json already exists in {target_dir.name} (use --force to rerun)")
        else:
            if not target_dir:
                target_dir = get_next_output_dir(name, OUTPUT_DIR)
            mf_path = target_dir / "manifest.json"
            rp_path = target_dir / "report.json"
            try:
                extract(url, target_dir, tool=name)
            except Exception as e:
                print(f"Extraction failed for {name}: {e}")

        # Parse results from manifest.json and report.json
        mf = json.loads(mf_path.read_text(encoding="utf-8")) if mf_path and mf_path.exists() else {}
        rp = json.loads(rp_path.read_text(encoding="utf-8")) if rp_path and rp_path.exists() else {}

        counts = mf.get("counts", {})
        skipped = rp.get("skipped", {})
        items = mf.get("items", [])

        is_bot_blocked = (
            rp.get("scroll_video", {}).get("blocked_by_bot_check")
            or rp.get("empty_reasons", {}).get("scroll") == "blocked_by_bot_check"
            or rp.get("status") == "blocked"
        )

        if is_bot_blocked:
            status = "blocked"
            notes = "manual capture needed"
        elif rp.get("status") == "ok":
            status = "ok"
            notes = ""
        else:
            status = "failed"
            notes = rp.get("message") or "extraction failed"

        videos_gifs = counts.get("videos_gifs", 0)
        images = counts.get("images", 0)
        embeds = len(rp.get("embeds", []))
        dups_removed = skipped.get("duplicate_sha256", 0) + skipped.get("duplicate_phash", 0)

        # Unique sections covered
        sections = set()
        for it in items:
            sec = it.get("section") or it.get("page_section")
            if sec and sec != "scroll":
                sections.add(sec)
        sections_covered = len(sections)
        seconds = rp.get("seconds", 0)

        row = {
            "tool": name,
            "status": status,
            "videos_gifs": videos_gifs,
            "images": images,
            "embeds": embeds,
            "duplicates_removed": dups_removed,
            "sections_covered": sections_covered,
            "seconds": seconds,
            "notes": notes,
            "_items": items,
            "_sections": sections,
        }
        results.append(row)

    # Write results.csv
    csv_cols = [
        "tool", "status", "videos_gifs", "images", "embeds",
        "duplicates_removed", "sections_covered", "seconds", "notes"
    ]
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=csv_cols)
        writer.writeheader()
        for r in results:
            writer.writerow({k: r[k] for k in csv_cols})
    print(f"\nSaved results to {CSV_PATH}")

    # Summary
    vids_2plus_sections = []
    only_hero_images = []
    blocked_tools = []

    for r in results:
        tname = r["tool"]
        if r["status"] == "blocked":
            blocked_tools.append(tname)

        vg_sections = set()
        img_sections = set()
        for it in r["_items"]:
            sec = it.get("section") or it.get("page_section")
            if not sec or sec == "scroll":
                continue
            cat = it.get("category")
            ttype = it.get("type", "")
            if cat == "videos_gifs" or ttype in ("video", "embed", "gif", "animated_webp"):
                vg_sections.add(sec)
            if cat == "images" or ttype == "image":
                img_sections.add(sec)

        if len(vg_sections) >= 2:
            vids_2plus_sections.append(tname)

        # only hero images: has images, all images in hero section, and no non-scroll videos/gifs
        if len(img_sections) > 0 and img_sections == {"hero"} and len(vg_sections) == 0:
            only_hero_images.append(tname)

    print("\n" + "="*65)
    print("  TEST 7 SUMMARY")
    print("="*65)
    print(f"  • Tools with videos/GIFs in 2+ sections : {', '.join(vids_2plus_sections) if vids_2plus_sections else 'None'}")
    print(f"  • Tools with only hero images           : {', '.join(only_hero_images) if only_hero_images else 'None'}")
    print(f"  • Tools blocked by bot check            : {', '.join(blocked_tools) if blocked_tools else 'None'}")
    print("="*65 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run 7-tool extraction test suite.")
    parser.add_argument("--force", action="store_true", help="Force rerun even if manifest.json exists")
    args = parser.parse_args()
    run_tests(force=args.force)

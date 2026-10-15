"""
run.py - run the whole pipeline for one tool.

    python run.py --tool "Pomelli" --url https://labs.google.com/pomelli --num 01
    python run.py --tool "Gamma" --url https://gamma.app --stages grab,qa

Stages, in order: script, grab, qa, match, trial, qa2, assemble, upload.
(grab records one clip per page section; match builds the shots from script.txt
and picks the best clip for each.)
trial only runs if shots failed QA and auth_<tool>.json exists. A stage that
errors is logged and the run carries on. Each stage's result goes to
out/<tool>/run.log, and the run adds a row to out/results.csv.
"""

import argparse
import csv
import json
import logging
import os
import time
import traceback
from datetime import datetime
from pathlib import Path

from . import assembler, describer, drive_upload, grabber, matcher, qa, script_gen, trial_recorder

ROOT = Path(__file__).resolve().parent.parent
ALL_STAGES = ["grab", "describe", "script", "match", "qa", "trial", "assemble", "upload"]
DEFAULT_STAGES = ["grab", "describe", "script", "match", "qa", "trial", "assemble"]
CSV_FIELDS = ["date", "tool", "website_shots_passed", "trial_shots_needed", "needs_manual", "errors"]


class Skip(Exception):
    """Stage didn't need to run; the message says why."""


def _manifest(tool_dir):
    path = tool_dir / "manifest.json"
    if not path.exists():
        raise Skip("no manifest.json (grab hasn't run)")
    return json.loads(path.read_text(encoding="utf-8"))


def _qa_summary(m):
    shots = m["shots"]
    covered = sum(bool(s.get("file")) and s.get("qa") == "pass" for s in shots)
    missing = len(shots) - covered
    return f"{covered}/{len(shots)} shots covered, {missing} missing (trial shots: {m.get('needs_trial') or 'none'})"


def run_pipeline(url, tool, stages=DEFAULT_STAGES, out_root="out", log=print, display_name=None, num=None, headed=False):
    """Run the stages in order. Returns {stage: {"status", "summary"}}."""
    slug = grabber.slugify(tool)
    url = url if url.startswith("http") else "https://" + url
    tool_dir = Path(out_root) / slug
    tool_dir.mkdir(parents=True, exist_ok=True)
    auth_file = ROOT / f"auth_{slug}.json"

    def grab():
        m = grabber.grab(url, slug, out_root, headed=headed)
        if m["status"] != "ok":
            raise RuntimeError(f"grab {m['status']}: {m['error']}")
        lib = m["library"]
        ok = sum(c.get("qa") == "pass" for c in lib)
        return (f"{len(lib)} section clips & segments ({ok} pass QA), "
                f"{len(m['site_videos'])} site videos")

    def describe():
        catalog = describer.describe(slug, out_root)
        ui_count = sum(bool(c.get("has_ui")) for c in catalog)
        return f"{len(catalog)} clips described ({ui_count} with UI) in clip_catalog.json"

    def script():
        _, shot_path = script_gen.generate(slug, url, out_root)
        shots = json.loads(Path(shot_path).read_text(encoding="utf-8"))
        trial = [s["shot"] for s in shots if s.get("source") == "trial"]
        return f"{len(shots)} shots, trial shots: {trial or 'none'}"

    def match():
        _manifest(tool_dir)
        m = matcher.match(slug, out_root)
        if not m.get("match", {}).get("ok"):
            raise RuntimeError(m.get("match", {}).get("note", "could not build shots"))
        web = [s for s in m["shots"] if s.get("source") == "website"]
        got = sum(bool(s.get("file")) for s in web)
        return (f"{len(m['shots'])} shots from the script, {got}/{len(web)} website shots matched, "
                f"{len(m['shots']) - len(web)} trial")

    def run_qa():
        _manifest(tool_dir)
        m = qa.run_qa(slug, out_root)
        return _qa_summary(m)

    def trial():
        m = _manifest(tool_dir)
        if not m.get("needs_trial"):
            raise Skip("no shots failed QA")
        if not auth_file.exists():
            log(f"  run login_once.py first:  python login_once.py {slug} <signup_url>")
            raise Skip(f"{auth_file.name} not found, run login_once.py")
        results = trial_recorder.record(slug, None, out_root)
        done = sum(r["status"] == "recorded" for r in results)
        return f"{done}/{len(results)} recorded, {len(results) - done} needs manual"

    def assemble():
        _manifest(tool_dir)
        path = assembler.assemble(slug, out_root)
        if path is None:
            raise RuntimeError("nothing to cut")
        return f"{path.name} ({qa.probe(path)[0]:.1f}s) + summary.md"

    def upload():
        drive_id = os.environ.get("DRIVE_FOLDER_ID", "").strip()
        if not drive_id:
            raise Skip("DRIVE_FOLDER_ID not set in .env")
        return drive_upload.upload(slug, out_root, display_name or tool, num)

    steps = {"grab": grab, "describe": describe, "script": script, "match": match,
             "qa": run_qa, "trial": trial, "assemble": assemble, "upload": upload}

    results = {}
    for stage in stages:
        log(f"> {stage} ...")
        t0 = time.monotonic()
        try:
            summary, status = steps[stage](), "ok"
        except Skip as e:
            summary, status = str(e), "skipped"
        except NotImplementedError:
            summary, status = "not built yet", "skipped"
        except Exception as e:
            summary, status = (str(e).splitlines()[0] if str(e) else type(e).__name__), "error"
            logging.getLogger("run").debug(traceback.format_exc())
        results[stage] = {"status": status, "summary": summary}
        log(f"  {stage}: {status.upper()} ({time.monotonic() - t0:.0f}s) - {summary}")
    return results


def results_row(tool, tool_dir, results):
    row = {"date": datetime.now().strftime("%Y-%m-%d %H:%M"), "tool": tool,
           "website_shots_passed": "", "trial_shots_needed": "", "needs_manual": ""}
    path = tool_dir / "manifest.json"
    if path.exists():
        shots = json.loads(path.read_text(encoding="utf-8")).get("shots", [])
        row["website_shots_passed"] = sum(bool(s.get("file")) and s.get("qa") == "pass" for s in shots)
        row["trial_shots_needed"] = sum(not s.get("file") or s.get("qa") != "pass" for s in shots)
        row["needs_manual"] = sum(s.get("status") == "needs_manual" for s in shots)
    row["errors"] = "; ".join(f"{k}: {v['summary']}" for k, v in results.items() if v["status"] == "error")
    return row


def append_results(out_root, row):
    path = Path(out_root) / "results.csv"
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)
    return path


def setup_log(tool_dir):
    """Log to the console and append to out/<tool>/run.log (tracebacks go to the file only)."""
    logger = logging.getLogger("run")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()
    fh = logging.FileHandler(tool_dir / "run.log", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S"))
    fh.setLevel(logging.DEBUG)
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(message)s"))
    ch.setLevel(logging.INFO)
    logger.addHandler(fh)
    logger.addHandler(ch)
    logger.propagate = False
    return logger


def main():
    ap = argparse.ArgumentParser(description="Website -> reel pipeline for one tool")
    ap.add_argument("--tool", required=True, help='tool name, e.g. "Pomelli" (also the Drive folder name)')
    ap.add_argument("--url", required=True, help="the tool's website")
    ap.add_argument("--num", help="Drive folder number, e.g. 01 (default: next free number)")
    ap.add_argument("--stages", default=",".join(DEFAULT_STAGES), help=f"comma-separated, from: {','.join(ALL_STAGES)}")
    ap.add_argument("--out", default="out")
    ap.add_argument("--headed", action="store_true", help="show the browser while recording")
    a = ap.parse_args()
    stages = [s.strip() for s in a.stages.split(",") if s.strip()]
    bad = [s for s in stages if s not in ALL_STAGES]
    if bad:
        ap.error(f"unknown stage(s): {', '.join(bad)}")

    slug = grabber.slugify(a.tool)
    tool_dir = Path(a.out) / slug
    tool_dir.mkdir(parents=True, exist_ok=True)
    logger = setup_log(tool_dir)
    logger.info(f"=== {a.tool} ({a.url}) stages: {','.join(stages)}")
    results = run_pipeline(a.url, a.tool, stages, a.out, log=logger.info, display_name=a.tool, num=a.num, headed=a.headed)

    row = results_row(a.tool, tool_dir, results)
    csv_path = append_results(a.out, row)
    logger.info(f"=== done: {row['website_shots_passed']} website shots passed, "
                f"{row['trial_shots_needed']} still need trial, {row['needs_manual']} needs manual, "
                f"{sum(r['status'] == 'error' for r in results.values())} errors")
    logger.info(f"log: {tool_dir / 'run.log'}  |  results: {csv_path}")
    if results.get("upload", {}).get("status") == "ok":
        logger.info(f"Drive folder: {results['upload']['summary']}")


if __name__ == "__main__":
    main()

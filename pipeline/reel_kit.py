"""
reel_kit.py - hooks and a lead magnet for one tool, made right after asset extraction.

    python -m pipeline.reel_kit --dir out/gamma.assets --tool Gamma --url https://gamma.app \
        --demo-type "3 core features" --keyword GUIDE --magnet checklist

Writes into the tool's folder:
  page_text.txt     the page's visible text, the context for the model
  hooks.json        4 hook variants, each from a different template in HOOK_TEMPLATES
  lead_magnet.html  templates/lead_magnet.html filled with the model's content (all text escaped)
  lead_magnet.pdf   the same page printed with Playwright's page.pdf()
Text comes from Groq (GROQ_API_KEY in .env); no other API is called. Progress lines start
with [PROGRESS] so app.py shows them as the job's stage.
"""

import argparse
import html
import json
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

from pipeline.browser_utils import launch_or_connect, safe_close

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "templates" / "lead_magnet.html"
CTA_BLOCKS = ROOT / "templates" / "cta_blocks.html"
LINKS = ROOT / "config" / "links.json"
GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"]
MAX_PAGE_CHARS = 12000
KIT_FILES = ("page_text.txt", "hooks.json", "lead_magnet.json", "lead_magnet.html", "lead_magnet.pdf")
LINK_KEYS = ("COURSE_URL", "LEAD_MAGNET_URL", "HELP_LINK_1", "HELP_LINK_2", "HELP_LINK_3", "HELP_LINK_4")

HOOK_TEMPLATES = [
    "The biggest mistake most people make...",
    "If you're trying to X but Y, it's probably because...",
    "Have you ever...",
    "So there's a new AI tool that lets you X and Y without Z",
    "So this new AI tool from [company] just dropped",
    "AI tools that save you time, part X: the old way vs the new way",
    "AI tools that make you / save you money",
    "So the fastest way to X",
]
DEMO_TYPES = ["3 core features", "1 use case end to end"]
MAGNET_TYPES = ["checklist", "playbook", "step-by-step guide"]


def progress(msg):
    print(f"[PROGRESS] {msg}", flush=True)


# ---------- page text ----------

PAGE_TEXT_JS = """() => {
  const meta = (n) => (document.querySelector(`meta[name="${n}"], meta[property="${n}"]`) || {}).content || "";
  return {title: document.title || "", description: meta("description") || meta("og:description"),
          text: document.body ? document.body.innerText : ""};
}"""


BOT_RE = re.compile(r"just a moment|verify(ing)? you are (a )?human|are you a robot|checking your browser|"
                    r"attention required|performing security verification|enable javascript and cookies", re.I)
DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0.0.0 Safari/537.36")
MIN_BODY_CHARS = 400


def _read_page(pw, url, headed):
    browser = launch_or_connect(pw, headed=headed, extra_args=["--disable-blink-features=AutomationControlled"])
    ctx = page = None
    try:
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, user_agent=DESKTOP_UA)
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        info = page.evaluate(PAGE_TEXT_JS)
        for _ in range(15):  # a JS bot check usually clears itself within a few seconds
            if not BOT_RE.search(f"{info.get('title', '')}\n{(info.get('text') or '')[:2000]}"):
                break
            page.wait_for_timeout(1000)
            info = page.evaluate(PAGE_TEXT_JS)
        return info
    finally:
        safe_close(page, ctx, browser)


def page_text(url):
    """Visible text of the page (title, meta description, body), whitespace collapsed.
    Tries headless, then a visible browser; raises if the page is still a bot check or nearly empty,
    so the model never writes hooks about a "Just a moment..." page."""
    problem = "page did not load"
    with sync_playwright() as pw:
        for headed in (False, True):
            try:
                info = _read_page(pw, url, headed)
            except Exception as e:
                problem = f"page did not load ({type(e).__name__})"
                continue
            lines = [re.sub(r"\s+", " ", ln).strip() for ln in (info.get("text") or "").splitlines()]
            body = "\n".join(ln for ln in lines if ln)
            if BOT_RE.search(f"{info.get('title', '')}\n{body[:2000]}"):
                problem = "the site showed a bot check"
            elif len(body) < MIN_BODY_CHARS:
                problem = f"the page has almost no readable text ({len(body)} characters)"
            else:
                text = f"Title: {info.get('title', '')}\nDescription: {info.get('description', '')}\n\n{body}"
                return text[:MAX_PAGE_CHARS]
            log_line = f"page text: {problem}" + ("; retrying with a visible browser" if not headed else "")
            print(log_line, flush=True)
    raise RuntimeError(f"could not read the page text: {problem}")


# ---------- Groq ----------

def groq_json(system, user):
    """One JSON object from Groq, trying each model in turn. Returns (data, model)."""
    key = (os.environ.get("GROQ_API_KEY") or os.environ.get("GROK_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("GROQ_API_KEY is not set in .env")
    import groq
    client = groq.Groq(api_key=key, timeout=90)
    last_err = None
    for model in GROQ_MODELS:
        try:
            resp = client.chat.completions.create(
                model=model, temperature=0.5, response_format={"type": "json_object"},
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
            return json.loads(resp.choices[0].message.content or ""), model
        except Exception as e:  # model unavailable, rate limit, bad JSON: try the next model
            last_err = e
    raise RuntimeError(f"Groq call failed: {type(last_err).__name__}: {str(last_err)[:200]}")


def context_block(tool, url, text, options):
    return (f"Tool: {tool}\nWebsite: {url}\nThe reel demos: {options['demo_type']}\n\n"
            f"<page_text>\n{text}\n</page_text>")


# ---------- hooks ----------

HOOKS_SYSTEM = """You write the opening hook for short vertical videos (Instagram Reels) about AI tools.
Use only facts found in the page text. Do not invent features, numbers, prices or company names.
Pick the 4 templates from the numbered list that fit this tool best (4 different ones) and fill each in:
replace X, Y, Z and [company] with specifics from the page, keep the template's opening words, and complete
the thought where the template ends in "..." (e.g. "...it's probably because you're still doing X by hand.").
Every hook is a complete sentence that never ends in "..." and is spoken in under 5 seconds (at most 25 words).
If the page doesn't name a company, don't pick the [company] template.

Templates:
{templates}

Return only JSON: {{"hooks": [{{"template_id": <1-8>, "hook": "<the filled-in hook>"}}, ...4 items]}}"""


def make_hooks(tool, url, text, options):
    system = HOOKS_SYSTEM.format(templates="\n".join(f"{i}. {t}" for i, t in enumerate(HOOK_TEMPLATES, 1)))
    user = context_block(tool, url, text, options)
    problem = None
    for _ in range(2):
        data, model = groq_json(system, user + (f"\n\nYour last answer was rejected: {problem}" if problem else ""))
        hooks, problem = check_hooks(data)
        if hooks:
            return hooks, model
    raise RuntimeError(f"hooks rejected twice: {problem}")


def check_hooks(data):
    items = data.get("hooks") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None, "no hooks list"
    hooks, seen, unfinished = [], set(), 0
    for it in items:
        try:
            tid = int(it.get("template_id"))
        except (TypeError, ValueError, AttributeError):
            continue
        text = str(it.get("hook") or "").strip()
        if text.endswith(("...", "…")):
            unfinished += 1
            continue
        if 1 <= tid <= len(HOOK_TEMPLATES) and text and tid not in seen:
            seen.add(tid)
            hooks.append({"template_id": tid, "template": HOOK_TEMPLATES[tid - 1], "hook": text})
    if len(hooks) < 4:
        why = f"; {unfinished} ended in '...' instead of finishing the sentence" if unfinished else ""
        return None, f"need 4 complete hooks from 4 different templates, got {len(hooks)}{why}"
    return hooks[:4], None


# ---------- lead magnet ----------

MAGNET_SYSTEM = """You write a short lead magnet: a free {kind} that viewers of a reel about an AI tool get
when they comment a keyword. Ground it in the page text; do not invent features, prices or numbers.
Make it practical: someone should be able to use it today.
- checklist: sections group checkable actions; each item is one action.
- playbook: each section is a play (a goal), items are the tactics for it.
- step-by-step guide: sections are steps in order, items are the details of each step.
3 to 6 sections, 3 to 6 items each, items at most 30 words. Plain text only, no markdown.

Return only JSON: {{"title": "...", "subtitle": "...", "intro": "<2-3 sentences>",
"sections": [{{"heading": "...", "items": ["...", "..."]}}], "cta": "<one closing sentence telling the reader to try the tool>"}}"""


def make_magnet(tool, url, text, options):
    kind = options["lead_magnet_type"]
    system = MAGNET_SYSTEM.format(kind=kind)
    user = context_block(tool, url, text, options) + f"\n\nWrite the {kind}."
    problem = None
    for _ in range(2):
        data, model = groq_json(system, user + (f"\n\nYour last answer was rejected: {problem}" if problem else ""))
        magnet, problem = check_magnet(data)
        if magnet:
            return magnet, model
    raise RuntimeError(f"lead magnet rejected twice: {problem}")


def check_magnet(data):
    if not isinstance(data, dict):
        return None, "not a JSON object"
    sections = []
    for s in data.get("sections") or []:
        if not isinstance(s, dict):
            continue
        items = [str(i).strip() for i in (s.get("items") or []) if str(i).strip()]
        # the template numbers sections itself ("Part 1", "Step 1"), so drop "1." / "Step 1:" from the model
        heading = re.sub(r"^\s*((step|play|part)\s*)?\d+\s*[.):\-]\s*", "", str(s.get("heading") or ""), flags=re.I).strip()
        if heading and items:
            sections.append({"heading": heading, "items": items})
    if not str(data.get("title") or "").strip():
        return None, "missing title"
    if len(sections) < 3:
        return None, f"need at least 3 sections with items, got {len(sections)}"
    return {k: str(data.get(k) or "").strip() for k in ("title", "subtitle", "intro", "cta")} | {"sections": sections}, None


def render_magnet(magnet, tool, url, options):
    """templates/lead_magnet.html with {{placeholders}} replaced. Every model string is HTML-escaped."""
    kind = options["lead_magnet_type"]
    tag = "ol" if kind == "step-by-step guide" else "ul"
    blocks = []
    for n, s in enumerate(magnet["sections"], 1):
        label = {"step-by-step guide": f"Step {n}", "playbook": f"Play {n}"}.get(kind, f"Part {n}")
        items = "".join(f"<li>{html.escape(i)}</li>" for i in s["items"])
        blocks.append(f'<section class="block"><div class="label">{label}</div>'
                      f'<h2>{html.escape(s["heading"])}</h2><{tag}>{items}</{tag}></section>')
    values = {k: html.escape(v) for k, v in {
        "title": magnet["title"], "subtitle": magnet["subtitle"], "intro": magnet["intro"], "cta": magnet["cta"],
        "tool": tool, "url": url, "kind": kind.capitalize(), "date": time.strftime("%B %Y"),
    }.items()}
    values.update(kind_class=re.sub(r"[^a-z]+", "-", kind), sections="\n".join(blocks))
    values.update(link_values())
    # Partials first (trusted template text), then one pass over the values, so text from the
    # model is never scanned for placeholders again.
    page = expand_partials(TEMPLATE.read_text(encoding="utf-8"))
    return re.sub(r"\{\{(\w+)\}\}", lambda m: values.get(m.group(1), m.group(0)), page)


def expand_partials(page):
    """Replace {{partial:NAME}} with that block from templates/cta_blocks.html."""
    blocks = dict(re.findall(r"<!-- partial: (\w+) -->\s*(.*?)\s*<!-- /partial -->",
                             CTA_BLOCKS.read_text(encoding="utf-8"), re.S))
    def sub(m):
        if m.group(1) not in blocks:
            raise RuntimeError(f"templates/cta_blocks.html has no partial named {m.group(1)!r}")
        return blocks[m.group(1)]
    return re.sub(r"\{\{partial:(\w+)\}\}", sub, page)


def link_values():
    """config/links.json, HTML-escaped. URLs that aren't http(s)/mailto (e.g. still empty) become '#'."""
    try:
        links = json.loads(LINKS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        links = {}
    out = {}
    for k, v in links.items():
        v = str(v or "").strip()
        if k in LINK_KEYS:
            v = v if re.match(r"^(https?://|mailto:)\S+$", v, re.I) else "#"
        out[k] = html.escape(v)
    for k in LINK_KEYS:
        out.setdefault(k, "#")
    return out


def export_pdf(page_html, pdf_path):
    with sync_playwright() as pw:
        browser = launch_or_connect(pw)  # page.pdf() needs headless Chromium
        ctx = page = None
        try:
            ctx = browser.new_context()
            page = ctx.new_page()
            page.set_content(page_html, wait_until="load")
            pdf_path.write_bytes(page.pdf(format="A4", print_background=True,
                                          margin={"top": "0", "bottom": "0", "left": "0", "right": "0"}))
        finally:
            safe_close(page, ctx, browser)


# ---------- main ----------

def clean_options(options):
    options = dict(options or {})
    if options.get("demo_type") not in DEMO_TYPES:
        options["demo_type"] = DEMO_TYPES[0]
    if options.get("lead_magnet_type") not in MAGNET_TYPES:
        options["lead_magnet_type"] = MAGNET_TYPES[0]
    options["comment_keyword"] = normalize_keyword(options.get("comment_keyword"))
    return options


def normalize_keyword(text):
    """Comment keyword as stored and matched: A-Z, 0-9, _ and -, uppercase, at most 30 chars
    (it is also the /go/<KEYWORD> path, so no spaces)."""
    return re.sub(r"[^A-Za-z0-9_-]", "", str(text or ""))[:30].upper()


def run_reel_kit(tool_dir, tool_name, url, options=None):
    """Write hooks.json, lead_magnet.html and lead_magnet.pdf into tool_dir. Returns a short summary."""
    tool_dir = Path(tool_dir)
    tool_dir.mkdir(parents=True, exist_ok=True)
    options = clean_options(options)
    url = url if "://" in url else "https://" + url
    for name in KIT_FILES:  # a failed run must not leave the previous run's kit looking current
        (tool_dir / name).unlink(missing_ok=True)

    progress("Reading page text")
    text = page_text(url)
    (tool_dir / "page_text.txt").write_text(text, encoding="utf-8")

    progress("Generating hooks")
    hooks, model = make_hooks(tool_name, url, text, options)
    kw, kind = options["comment_keyword"], options["lead_magnet_type"]
    kit = {"tool": tool_name, "url": url, "demo_type": options["demo_type"], "comment_keyword": kw,
           "lead_magnet_type": kind, "cta": f'Comment "{kw}" and I\'ll send you the {kind}.' if kw else "",
           "model": model, "generated": time.strftime("%Y-%m-%d %H:%M:%S"), "hooks": hooks}
    (tool_dir / "hooks.json").write_text(json.dumps(kit, indent=2, ensure_ascii=False), encoding="utf-8")

    progress("Generating lead magnet")
    magnet, _ = make_magnet(tool_name, url, text, options)
    # The model's content on its own, so --rerender can rebuild the HTML/PDF (e.g. after links.json changes).
    (tool_dir / "lead_magnet.json").write_text(json.dumps(
        {"tool": tool_name, "url": url, "options": options, "magnet": magnet}, indent=2, ensure_ascii=False),
        encoding="utf-8")
    write_magnet_files(tool_dir, magnet, tool_name, url, options)
    return f"{len(hooks)} hooks, {kind} '{magnet['title']}' ({len(magnet['sections'])} sections) + PDF"


def write_magnet_files(tool_dir, magnet, tool_name, url, options):
    page_html = render_magnet(magnet, tool_name, url, options)
    (tool_dir / "lead_magnet.html").write_text(page_html, encoding="utf-8")
    progress("Exporting lead magnet PDF")
    export_pdf(page_html, tool_dir / "lead_magnet.pdf")


def rerender(tool_dir):
    """Rebuild lead_magnet.html/.pdf from lead_magnet.json with the current templates and links. No API call."""
    tool_dir = Path(tool_dir)
    saved = json.loads((tool_dir / "lead_magnet.json").read_text(encoding="utf-8"))
    write_magnet_files(tool_dir, saved["magnet"], saved["tool"], saved["url"], clean_options(saved.get("options")))
    return f"re-rendered {tool_dir.name}/lead_magnet.html + .pdf"


def main():
    ap = argparse.ArgumentParser(description="Hooks + lead magnet for one tool")
    ap.add_argument("--dir", help="the tool's output folder")
    ap.add_argument("--tool")
    ap.add_argument("--url")
    ap.add_argument("--demo-type", default="")
    ap.add_argument("--keyword", default="")
    ap.add_argument("--magnet", default="")
    ap.add_argument("--rerender", metavar="DIR", help="only rebuild DIR's lead magnet HTML/PDF from lead_magnet.json")
    a = ap.parse_args()
    if not a.rerender and not (a.dir and a.tool and a.url):
        ap.error("--dir, --tool and --url are required (or use --rerender DIR)")
    load_dotenv(ROOT / ".env")
    try:
        if a.rerender:
            summary = rerender(a.rerender)
        else:
            summary = run_reel_kit(a.dir, a.tool, a.url, {"demo_type": a.demo_type, "comment_keyword": a.keyword,
                                                          "lead_magnet_type": a.magnet})
    except Exception as e:
        print(f"reel kit failed: {str(e).splitlines()[0] if str(e) else type(e).__name__}", flush=True)
        return 1
    print(f"> Reel Kit done: {summary}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

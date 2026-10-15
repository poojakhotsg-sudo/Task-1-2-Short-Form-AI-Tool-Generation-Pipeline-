"""
script_gen.py - stage 1: write the reel script and shot list for a tool.

    python -m pipeline.script_gen pomelli https://labs.google.com/pomelli

1. Fetches the site's text with Playwright (home page + up to 2 feature/product pages,
   plus the title/description of any embedded YouTube/Vimeo demo).
2. Asks Claude for a 30-45s reel: either 1 full use case or 3 core features.
3. Writes out/<tool>/script.txt and out/<tool>/shot_list.json (a validated list of shots).

Needs ANTHROPIC_API_KEY in .env (or the environment).
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List, Literal, Optional
from urllib.parse import urljoin, urlparse

import anthropic
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from pydantic import BaseModel, ValidationError

from .grabber import EMBED_RE, close_cookie_popups, slugify

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

MODEL = "claude-opus-5-5"
MAX_SITE_CHARS = 40_000
MIN_TOTAL_S, MAX_TOTAL_S = 30, 45
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
SUBPAGE_HINT = re.compile(r"feature|product|how-it-works|use-case|solutions|examples|showcase", re.I)
# Trial steps are things to do inside the tool once a person has signed in themselves.
FORBIDDEN_STEP = re.compile(r"password|passcode|credit card|card number|card details|cvv|cvc|billing|payment", re.I)


# ---------- schema ----------

class Shot(BaseModel):
    shot: int
    time: str = ""
    duration_seconds: float
    script_line: str
    clip_file: Optional[str] = None
    source: Literal["website", "trial"] = "website"
    visual_needed: str = ""
    trial_steps: List[str] = []


class Reel(BaseModel):
    angle: Literal["use_case", "core_features"]
    angle_summary: str
    shots: List[Shot]


SHOT_SCHEMA = {
    "type": "object",
    "properties": {
        "shot": {"type": "integer"},
        "time": {"type": "string"},
        "duration_seconds": {"type": "number"},
        "script_line": {"type": "string"},
        "clip_file": {"type": ["string", "null"]},
        "source": {"type": "string", "enum": ["website", "trial"]},
        "visual_needed": {"type": "string"},
        "trial_steps": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["shot", "script_line", "source", "duration_seconds"],
    "additionalProperties": False,
}
REEL_SCHEMA = {
    "type": "object",
    "properties": {
        "angle": {"type": "string", "enum": ["use_case", "core_features"]},
        "angle_summary": {"type": "string"},
        "shots": {"type": "array", "items": SHOT_SCHEMA},
    },
    "required": ["angle", "angle_summary", "shots"],
    "additionalProperties": False,
}

SYSTEM = f"""You write short-form vertical video reels (Instagram Reels / TikTok / Shorts) that show off AI tools.
You MUST write an asset-first reel script built around the real video clips provided in the clip catalog.

Rules for writing the script:
1. Build the script directly around what the clips in the catalog actually show.
2. Every shot must name the exact `clip_file` from the catalog that illustrates the spoken line (e.g. "clips/site_video01_seg01.mp4"), or null if trial.
3. Use "trial" (with clip_file: null) ONLY if no clip in the catalog can illustrate the line, and NEVER use more than 2 trial shots in the entire reel.
4. Prefer reusing an existing clip over a trial shot, and rewrite the spoken voiceover line to fit what the clip actually shows rather than inventing things not shown.
5. All shots together must total {MIN_TOTAL_S}-{MAX_TOTAL_S} seconds. Individual shots must be between 3 and 8 seconds each.
6. The first shot is a snappy hook; the last shot is a CTA.
7. Return JSON matching the schema."""


# ---------- site text ----------

def _page_text(page):
    return page.evaluate("""() => {
      const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
      return [document.title, meta ? meta.content : '', document.body ? document.body.innerText : '']
        .filter(Boolean).join('\\n');
    }""")


def _load(page, url):
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        pass
    page.wait_for_timeout(1500)
    close_cookie_popups(page)
    # Scroll so lazy-loaded sections render their text.
    page.evaluate("async () => { for (let y = 0; y < document.body.scrollHeight; y += 900)"
                  " { scrollTo(0, y); await new Promise(r => setTimeout(r, 150)); } }")
    return _page_text(page)


def _embed_info(src):
    """Title + description of an embedded YouTube/Vimeo video via yt-dlp, or '' if unavailable."""
    ytdlp = shutil.which("yt-dlp")
    if not ytdlp:
        return ""
    try:
        r = subprocess.run([ytdlp, "--skip-download", "--no-warnings", "--print", "%(title)s",
                            "--print", "%(description)s", src],
                           capture_output=True, text=True, encoding="utf-8", timeout=60)
    except subprocess.TimeoutExpired:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def fetch_site_text(url, max_subpages=2):
    """Return the visible text of the home page plus a couple of feature/product pages."""
    url = url if url.startswith("http") else "https://" + url
    parts = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(user_agent=UA, viewport={"width": 1440, "height": 900})
        home = _load(page, url)
        if re.search(r"just a moment|verify you are human|checking your browser", home[:300], re.I):
            page.wait_for_timeout(8000)  # give bot checks a chance to clear
            home = _page_text(page)
        parts.append(f"=== {page.url}\n{home}")

        # Thin landing pages often explain the product in an embedded demo video instead.
        for src in page.evaluate("[...document.querySelectorAll('iframe')].map(f => f.src)"):
            if EMBED_RE.search(src or ""):
                info = _embed_info(src.split("?")[0])
                if info:
                    parts.append(f"=== embedded video {src}\n{info}")

        host = urlparse(page.url).netloc
        links = page.evaluate("[...document.querySelectorAll('a[href]')].map(a => a.href)")
        subpages = []
        for link in links:
            link = link.split("#")[0]
            if urlparse(link).netloc == host and SUBPAGE_HINT.search(link) and link not in subpages + [page.url]:
                subpages.append(link)
        for link in subpages[:max_subpages]:
            try:
                parts.append(f"=== {link}\n{_load(page, link)}")
            except Exception as e:
                print(f"  ! skipped {link}: {e}")
        browser.close()

    text = re.sub(r"\n\s*\n+", "\n", "\n\n".join(parts)).strip()
    if len(text) > MAX_SITE_CHARS:
        print(f"  site text is {len(text):,} chars; using the first {MAX_SITE_CHARS:,}")
        text = text[:MAX_SITE_CHARS]
    return text


# ---------- validation ----------

# ---------- validation ----------

def validate_reel(data):
    """Parse + check the model's output. Returns (Reel, []) or (None, [errors])."""
    try:
        reel = Reel.model_validate(data)
    except ValidationError as e:
        return None, [f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()]

    errors = []
    shots = reel.shots
    if len(shots) < 3:
        errors.append(f"only {len(shots)} shots; need at least 3 (hook, body, CTA)")
    if [s.shot for s in shots] != list(range(1, len(shots) + 1)):
        errors.append("shot numbers must run 1, 2, 3... in order")
    total = sum(s.duration_seconds for s in shots)
    if not (MIN_TOTAL_S <= total <= MAX_TOTAL_S):
        errors.append(f"total duration is {total:g}s; must be {MIN_TOTAL_S}-{MAX_TOTAL_S}s")
    trial_count = sum(s.source == "trial" for s in shots)
    if trial_count > 2:
        errors.append(f"reel has {trial_count} trial shots; maximum allowed is 2 (prefer existing clips)")
    for s in shots:
        tag = f"shot {s.shot}"
        if not (1 <= s.duration_seconds <= 15):
            errors.append(f"{tag}: duration {s.duration_seconds:g}s must be 1-15s")
        if not s.script_line.strip():
            errors.append(f"{tag}: script_line must not be empty")
        if not s.visual_needed.strip():
            s.visual_needed = s.clip_file or (f"demo of {s.script_line[:30]}")
        if s.source == "trial" and not s.trial_steps:
            s.trial_steps = ["Demonstrate feature inside tool"]
        if s.source == "website" and s.trial_steps:
            s.trial_steps = []
        for step in s.trial_steps:
            if FORBIDDEN_STEP.search(step):
                errors.append(f"{tag}: trial step mentions login/payment details, remove it: {step!r}")
    return (reel, []) if not errors else (None, errors)


# ---------- Model calls (Claude & Groq) ----------

def _ask(client, messages, is_groq=False):
    if is_groq:
        import json
        groq_messages = [
            {"role": "system", "content": SYSTEM + "\n\nCRITICAL: Output must be ONLY a valid JSON object matching this schema (no commentary):\n" + json.dumps(REEL_SCHEMA)}
        ]
        for m in messages:
            c = m["content"]
            if not isinstance(c, str):
                c = "".join(getattr(b, "text", str(b)) for b in c)
            groq_messages.append({"role": m["role"], "content": c})

        for model_name in ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]:
            try:
                resp = client.chat.completions.create(
                    model=model_name,
                    messages=groq_messages,
                    response_format={"type": "json_object"},
                    temperature=0.3,
                )
                text = resp.choices[0].message.content or ""
                return text, text
            except Exception as e:
                last_err = e
                continue
        raise RuntimeError(f"Groq API call failed: {last_err}")

    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        messages=messages,
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": REEL_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise RuntimeError(f"Claude declined the request (category: {category})")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("response hit max_tokens before the JSON was complete")
    text = "".join(b.text for b in response.content if b.type == "text")
    return response, text


def write_reel(tool, url, site_text, clip_catalog=None, attempts=2):
    groq_key = os.environ.get("GROQ_API_KEY") or os.environ.get("GROK_API_KEY")
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")

    is_groq = bool(groq_key) and not anthropic_key
    if is_groq:
        import groq
        client = groq.Groq(api_key=groq_key)
    else:
        client = anthropic.Anthropic()

    cat_str = json.dumps(clip_catalog or [], indent=2)
    messages = [{
        "role": "user",
        "content": (
            f"Tool name: {tool}\nWebsite: {url}\n\n"
            f"<clip_catalog>\n{cat_str}\n</clip_catalog>\n\n"
            f"<website_text>\n{site_text}\n</website_text>"
        ),
    }]
    errors = []
    for attempt in range(1, attempts + 1):
        response, text = _ask(client, messages, is_groq=is_groq)
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            data, errors = None, [f"not valid JSON: {e}"]
        if data is not None:
            reel, errors = validate_reel(data)
            if reel:
                return reel
        print(f"  attempt {attempt}: shot list failed validation: {'; '.join(errors)}")
        # Append-only retry: keep the model's answer and ask it to fix the listed problems.
        asst_content = text if is_groq else response.content
        messages += [
            {"role": "assistant", "content": asst_content},
            {"role": "user", "content": "That shot list has problems:\n- " + "\n- ".join(errors)
             + "\nReturn the full corrected JSON."},
        ]
    raise ValueError("shot list still invalid after retries: " + "; ".join(errors))


# ---------- output ----------

def render_script(tool, url, reel):
    angle = "1 full use case" if reel.angle == "use_case" else "3 core features"
    total = sum(s.duration_seconds for s in reel.shots)
    lines = [f"{tool.upper()} - {total:g}s reel script", f"Tool: {tool} - {url}",
             f"Angle: {angle} - {reel.angle_summary}", ""]
    t, step, last = 0.0, 0, len(reel.shots) - 1
    for i, s in enumerate(reel.shots):
        if i == 0:
            label = "HOOK"
        elif i == last:
            label = "CTA"
        elif s.source == "trial":
            label = "PROOF"
        else:
            step += 1
            label = f"STEP {step}"
        clip_tag = f" ({s.clip_file})" if s.clip_file else f" ({s.source})"
        vis = s.visual_needed or (s.clip_file or "")
        lines.append(f"[{t:g}-{t + s.duration_seconds:g}s]  {label} - {vis[:60]}{clip_tag}")
        lines.append(s.script_line)
        lines.append("")
        t += s.duration_seconds
    return "\n".join(lines)


def generate(tool, url, out_root="out"):
    """Write out/<tool>/script.txt and shot_list.json using site text and clip catalog. Returns (script_path, shot_list_path)."""
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("GROQ_API_KEY") or os.environ.get("GROK_API_KEY"))
    if not has_key:
        raise RuntimeError("No LLM API key set: set GROK_API_KEY, GROQ_API_KEY, or ANTHROPIC_API_KEY in .env")
    url = url if url.startswith("http") else "https://" + url
    out_dir = Path(out_root) / slugify(tool)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Load clip catalog if present
    cat_path = out_dir / "clip_catalog.json"
    clip_catalog = []
    if cat_path.exists():
        try:
            clip_catalog = json.loads(cat_path.read_text(encoding="utf-8"))
            print(f"> loaded clip catalog: {len(clip_catalog)} clips")
        except Exception as e:
            print(f"> warning: could not read clip_catalog.json: {e}")

    print(f"> fetching site text from {url}")
    site_text = fetch_site_text(url)
    if len(site_text) < 200:
        raise RuntimeError(f"only got {len(site_text)} characters of text from {url}; the site may be blocking bots")
    print(f"  {len(site_text):,} chars")

    model_desc = "Groq" if (os.environ.get("GROQ_API_KEY") or os.environ.get("GROK_API_KEY")) and not os.environ.get("ANTHROPIC_API_KEY") else MODEL
    print(f"> writing script with {model_desc}")
    reel = write_reel(tool, url, site_text, clip_catalog=clip_catalog)

    script_path = out_dir / "script.txt"
    shot_path = out_dir / "shot_list.json"
    script_path.write_text(render_script(tool, url, reel), encoding="utf-8")
    shot_path.write_text(json.dumps([s.model_dump() for s in reel.shots], indent=2, ensure_ascii=False),
                         encoding="utf-8")
    trial = [s.shot for s in reel.shots if s.source == "trial"]
    print(f"  angle: {reel.angle}  |  {len(reel.shots)} shots  |  "
          f"{sum(s.duration_seconds for s in reel.shots):g}s  |  trial shots: {trial or 'none'}")
    return script_path, shot_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: python -m pipeline.script_gen <tool> <url> [out_root]")
    try:
        for path in generate(sys.argv[1], sys.argv[2], *sys.argv[3:4]):
            print(f"Saved {path}")
    except anthropic.AuthenticationError:
        sys.exit("Anthropic API key missing or invalid: set ANTHROPIC_API_KEY in .env")
    except anthropic.RateLimitError:
        sys.exit("Rate limited by the Anthropic API; try again in a minute")
    except anthropic.APIConnectionError:
        sys.exit("Could not reach the Anthropic API; check your connection")
    except (anthropic.APIStatusError, RuntimeError, ValueError) as e:
        sys.exit(f"script_gen failed: {e}")

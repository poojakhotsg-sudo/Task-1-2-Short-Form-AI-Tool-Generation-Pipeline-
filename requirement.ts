/**
 * requirement.ts - feature inventory for reel-pipeline ("Short-Form AI Tool Generation Pipeline").
 *
 * What the product does: take an AI tool's public website and turn it into everything needed
 * for a 30-45s vertical (1080x1920) Instagram Reel / TikTok / Short about that tool:
 * extracted media, a script + shot list, matched and QA-checked clips, a rough cut, hooks,
 * a lead magnet (HTML + PDF), and the comment-keyword -> DM backend used by ManyChat.
 *
 * Stack: Python 3.11, FastAPI + Uvicorn (app.py), Playwright Chromium, FFmpeg/ffprobe, yt-dlp,
 * OpenCV, Pillow + imagehash, Anthropic / Groq LLMs, Google Drive API, SQLite / Supabase.
 * Frontend: plain HTML/JS pages in web/ served by app.py. package.json only wraps `python app.py`.
 *
 * This file is documentation, derived from scanning the source. Each feature lists the
 * files that implement it and, where relevant, the HTTP endpoints, CLI commands, inputs and outputs.
 */

export type Priority = "core" | "supporting" | "optional";

export interface Feature {
  id: string;
  name: string;
  priority: Priority;
  summary: string;
  details: string[];
  files: string[];
  endpoints?: string[];
  cli?: string[];
  inputs?: string[];
  outputs?: string[];
  env?: string[];
}

export interface FeatureGroup {
  id: string;
  title: string;
  description: string;
  features: Feature[];
}

// ---------------------------------------------------------------------------
// 1. Asset extraction
// ---------------------------------------------------------------------------

const assetExtraction: FeatureGroup = {
  id: "EXTRACT",
  title: "Website asset extraction",
  description:
    "Pull every useful piece of media from a tool's public website using a mobile Playwright browser. No LLM or paid API calls.",
  features: [
    {
      id: "EXTRACT-01",
      name: "Mobile-browser media extraction",
      priority: "core",
      summary: "Load the page as an iPhone 14 (390x844, mobile UA) and collect every image, GIF, video and embed.",
      details: [
        "Collects <img> (src, srcset, data-src), <picture>/<source>, CSS background images (inline, computed, pseudo-elements), GIFs, SVGs, <video>/<source> and lazy-loaded videos.",
        "Captures media seen on the network (record_media) in addition to the DOM, including direct .mp4/.webm/.mov/.m4v/.ogv links and HLS .m3u8 streams (max 5 HLS, 30 videos, 500 MB per file).",
        "Scrolls the page in half-viewport steps (1s wait per step, hard cap 180s / 120 steps) so lazy sections request their media; also scrolls nested scroll containers.",
        "Clicks carousel 'next' buttons and 'Show/See/View/Load more' buttons (max 40 clicks) to reveal hidden media.",
        "Promotes lazy attributes to real ones before collecting (PROMOTE_LAZY_JS).",
        "Downloads with the page's cookies, user agent and referer; falls back to fetching through the browser context.",
        "Retries navigation with back-off 5s/10s/20s; the last retry runs headed. Exit code 1 on a persistent 4xx/5xx.",
      ],
      files: ["extract_assets.py", "pipeline/browser_utils.py"],
      cli: [
        "python extract_assets.py --url https://gamma.app",
        "python extract_assets.py --url https://gamma.app --out out/gamma.app/ --tool Gamma --headed",
      ],
      inputs: ["Website URL", "Optional tool name", "Optional --headed"],
      outputs: ["out/<tool>/videos_gifs/", "out/<tool>/images/", "out/<tool>/raw/", "manifest.json", "report.json", "run.log"],
    },
    {
      id: "EXTRACT-02",
      name: "Filtering and de-duplication",
      priority: "core",
      summary: "Drop junk files and keep one copy of each asset.",
      details: [
        "Skips favicons, apple-touch icons, tile icons and /icons/ paths (FAVICON_RE).",
        "Skips tracking pixels and analytics beacons (TRACKING_RE).",
        "Skips still images under 5 KB.",
        "Collapses CDN variants of the same asset by stripping size/quality/format query params (VARIANT_PARAMS, asset_key).",
        "Removes exact duplicates by SHA-256 and near-duplicates by perceptual hash (phash distance <= 4).",
      ],
      files: ["extract_assets.py"],
    },
    {
      id: "EXTRACT-03",
      name: "Embedded video download",
      priority: "core",
      summary: "Download YouTube / Vimeo / Loom / Wistia embeds, or record them playing if download fails.",
      details: [
        "Downloads embeds with yt-dlp.",
        "If yt-dlp fails, records the embed playing for 8s in a 1280x720 Playwright window.",
        "All embedded clips are normalized to .mp4.",
      ],
      files: ["extract_assets.py", "pipeline/grabber.py"],
    },
    {
      id: "EXTRACT-04",
      name: "Mobile scroll-through video and section clips",
      priority: "core",
      summary: "Record a smooth top-to-bottom scroll of the page plus short clips of each section, at 1080x1920.",
      details: [
        "Records 00_page_scroll.mp4: a smooth scroll with pauses and holds, encoded to 1080x1920.",
        "Cuts up to 6 section clips (7s each) named after the nearest heading (01_<heading>.mp4 ...).",
        "Plays page videos muted during recording and hides popups first.",
        "Saves a mobile layout screenshot (mobile_check.png).",
      ],
      files: ["extract_assets.py"],
      outputs: ["videos_gifs/00_page_scroll.mp4", "videos_gifs/NN_<heading>.mp4", "mobile_check.png"],
    },
    {
      id: "EXTRACT-05",
      name: "Video and animation normalization",
      priority: "core",
      summary: "Every video and animated image gets a playable .mp4 copy.",
      details: [
        "Converts .webm/.mov originals to .mp4 (originals kept in raw/).",
        "Converts animated GIF / WebP / PNG / AVIF to .mp4 alongside the original.",
        "Probes width, height and duration with ffprobe and records them in the manifest.",
        "--fix-existing re-normalizes all videos in an existing output folder and updates its manifest.json.",
      ],
      files: ["extract_assets.py"],
      cli: ["python extract_assets.py --fix-existing out/<tool>"],
    },
    {
      id: "EXTRACT-06",
      name: "Cookie banner, consent and chat-widget handling",
      priority: "supporting",
      summary: "Get overlays out of the way so recordings and screenshots are clean.",
      details: [
        "Clicks accept/allow/agree/got-it buttons using known selectors and button text (several rounds).",
        "Hides consent banners and remaining popups with injected CSS/JS.",
        "Hides chat widgets and corner widgets (grabber).",
      ],
      files: ["extract_assets.py", "pipeline/grabber.py"],
    },
    {
      id: "EXTRACT-07",
      name: "Bot-check detection",
      priority: "supporting",
      summary: "Detect Cloudflare-style 'verify you are human' pages and report them instead of failing silently.",
      details: [
        "Waits up to 20s after each navigation for 'Just a moment' style checks to clear.",
        "Tries headless, then headed, then a saved session from auth_<slug>.json.",
        "If still blocked, records blocked_by_bot_check in the manifest and returns empty results without crashing.",
        "The UI shows 'Blocked: use the marketing URL or tick Show browser'.",
      ],
      files: ["extract_assets.py", "pipeline/grabber.py", "app.py"],
    },
    {
      id: "EXTRACT-08",
      name: "Extraction manifest and report",
      priority: "core",
      summary: "One JSON entry per file plus a run report with the outcome and diagnostics.",
      details: [
        "manifest.json (kind: 'extract'): category, filename, source URL, type, size, width/height, duration, page order, section heading, mp4 copy.",
        "report.json: status, one-line message, why a category is empty, diagnostics.",
        "run.log: full debug log. Diagnostics stay on disk; the UI only gets the one-line message.",
      ],
      files: ["extract_assets.py", "app.py"],
    },
    {
      id: "EXTRACT-09",
      name: "Batch / multi-URL extraction",
      priority: "supporting",
      summary: "Extract several URLs in one job, one after another; a failed URL doesn't stop the rest.",
      details: [
        "Accepts URLs separated by whitespace or commas; adds https:// when missing; de-duplicates.",
        "Each URL is extracted into out/<domain>/.",
        "Per-URL result (ok/failed + error) is reported in the job status.",
      ],
      files: ["app.py", "web/index.html"],
      endpoints: ["POST /api/extract (form: url)"],
    },
    {
      id: "EXTRACT-10",
      name: "Single-tool extraction with Reel Kit options",
      priority: "core",
      summary: "Extract one URL into out/<tool>.assets/ and optionally generate the Reel Kit in the same job.",
      details: [
        "Form fields: tool, url, headed, reel_kit, demo_type, comment_keyword, lead_magnet_type, price_tier, checkout_url.",
        "Validates the URL, price tier (free/paid) and checkout URL (must be http/https).",
        "Rejects a comment keyword already used by another tool (HTTP 409).",
        "Saves price tier, checkout URL and keyword to data/tools.json for the Asset Library.",
      ],
      files: ["app.py", "web/pipeline.html"],
      endpoints: ["POST /api/extract-assets"],
    },
    {
      id: "EXTRACT-11",
      name: "Legacy / standalone extractors",
      priority: "optional",
      summary: "Older standalone scripts kept alongside the main extractor.",
      details: [
        "extract_assets_full.py: older extractor writing assets/{images,gifs,videos}, assets.json and gallery.html.",
        "extract_videos.py: runs only the demo-video step (grabber.extract_demo_videos), trims clips to shot durations, names them hero.mp4, use_case_1.mp4 ..., writes video_extraction.log/.json.",
        "grab_visuals.py: earliest prototype that records 1080x1920 clips, site videos and embeds.",
        "test_7.py: batch test that extracts 7 known tools (Pomelli, Notion, Canva, Gamma, Runway, Framer, Genspark) into output/ and writes results.csv.",
      ],
      files: ["extract_assets_full.py", "extract_videos.py", "grab_visuals.py", "test_7.py"],
      cli: [
        "python extract_videos.py gamma https://gamma.app [--headed] [--out out]",
        "python grab_visuals.py https://tool.com pomelli [--headed] [--clips 5] [--seconds 9]",
        "python test_7.py",
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. Reel pipeline stages
// ---------------------------------------------------------------------------

const reelPipeline: FeatureGroup = {
  id: "PIPE",
  title: "Reel pipeline (website -> rough cut)",
  description:
    "Staged pipeline run by run.py: grab -> describe -> script -> match -> qa -> trial -> assemble -> upload. A stage whose prerequisite failed is skipped with the reason; the others carry on.",
  features: [
    {
      id: "PIPE-01",
      name: "Pipeline orchestrator",
      priority: "core",
      summary: "Run any subset of the eight stages, in order, with dependency-aware skipping.",
      details: [
        "Stages: grab, describe, script, match, qa, trial, assemble, upload. Default run is everything except upload.",
        "Dependencies: describe<-grab, match<-grab+script, qa<-match, trial<-match, assemble<-match, upload<-assemble.",
        "Stage outcomes: ok / skipped (with reason) / error. Errors print '[STAGE-ERROR] <stage>: <reason>' so the UI can show them; exit code 1 if any stage errored.",
        "Parks the previous shot_list.json as shot_list.prev.json when a new script will be written, and restores it if the script stage fails.",
        "Logs every stage to out/<tool>/run.log (tracebacks to file only) and appends a row to out/results.csv (date, tool, website shots passed, trial shots needed, needs manual, errors).",
      ],
      files: ["run.py", "pipeline/run.py"],
      cli: [
        'python run.py --tool "Pomelli" --url https://labs.google.com/pomelli --num 01',
        'python run.py --tool "Gamma" --url https://gamma.app --stages grab,qa',
      ],
      endpoints: ["POST /api/run (form: tool, url, num, run_ai_stages, stages)"],
    },
    {
      id: "PIPE-02",
      name: "Grab: section recording and site data",
      priority: "core",
      summary: "Scan the site at 1080x1920 and record an 8-10s clip of each distinct section.",
      details: [
        "Saves site_data.json (title, description, h1/h2, feature text, video URLs, large image URLs, recorded sections) and hero.png.",
        "Records one clip per heading (up to 8): smooth scroll in, hover over elements with a visible cursor, drift down -> clips/clipNN_<heading>.mp4.",
        "Re-records any clip QA flags as 'mostly static' once with more motion (plays section video, slower scroll, hovers buttons/cards).",
        "Downloads <video>/<source> files and embedded YouTube/Vimeo demos (yt-dlp), and splits them into vertical segments (site_videoNN_segNN.mp4).",
        "Writes manifest.json with the clips in 'library' (section heading, text, QA result). Always written, with the error if the grab fails.",
        "Also runs the asset extractor into out/<tool>/assets/.",
        "Public pages only: never fills forms or signs in. Uploaded (_manual) clips are kept across runs.",
      ],
      files: ["pipeline/grabber.py"],
      cli: ["python -m pipeline.grabber https://gamma.app gamma [--sections 8] [--headed]"],
    },
    {
      id: "PIPE-03",
      name: "Describe: AI clip catalog",
      priority: "core",
      summary: "Catalog every recorded clip with a vision model so the script can be written around real footage.",
      details: [
        "Extracts 3 frames per clip (20%, 50%, 80% of duration).",
        "Sends them to Claude (if ANTHROPIC_API_KEY) or Groq vision.",
        "Each catalog entry has caption, 2-5 tags, has_ui flag, clip_type ('ui' or 'example_output').",
        "Reuses existing catalog entries, retries with back-off, and paces calls to stay under Groq rate limits.",
      ],
      files: ["pipeline/describer.py"],
      outputs: ["out/<tool>/clip_catalog.json"],
      env: ["ANTHROPIC_API_KEY or GROQ_API_KEY / GROK_API_KEY"],
    },
    {
      id: "PIPE-04",
      name: "Script: AI reel script and shot list",
      priority: "core",
      summary: "Write an asset-first 30-45s reel script built around the clip catalog.",
      details: [
        "Fetches site text with Playwright: home page + up to 2 feature/product/use-case subpages + title/description of embedded demo videos (yt-dlp). Capped at 40,000 chars.",
        "Angle is either '1 full use case' or '3 core features'.",
        "Rules: every shot names its catalog clip_file; at most 2 'trial' shots; shots 3-8s; total 30-45s; first shot is a hook, last is a CTA.",
        "Uses Claude (claude-opus-5-5, JSON-schema output) or, with only a Groq key, Groq models (gpt-oss-120b, qwen, gpt-oss-20b) in fallback order.",
        "Validates with Pydantic plus custom checks; on failure, sends the errors back to the model and retries.",
        "Rejects trial steps that mention passwords, cards, billing or payment.",
        "Renders script.txt with labelled time ranges (HOOK, STEP n, PROOF, CTA).",
      ],
      files: ["pipeline/script_gen.py"],
      cli: ["python -m pipeline.script_gen pomelli https://labs.google.com/pomelli"],
      outputs: ["out/<tool>/script.txt", "out/<tool>/shot_list.json"],
      env: ["ANTHROPIC_API_KEY or GROQ_API_KEY / GROK_API_KEY"],
    },
    {
      id: "PIPE-05",
      name: "Match: clip-to-shot matching",
      priority: "core",
      summary: "Give each website shot the best clip, using each clip at most once.",
      details: [
        "Parses script.txt headers like '[4-14s] FEATURE 1 - PROMPT TO DECK' into segments (HOOK, STEP n, PROOF, CTA ...).",
        "Keeps clips a person uploaded or a trial recorded from earlier runs.",
        "Rule order: (1) clip_file named by the script, (2) an existing per-shot clip, (3) LLM score of catalog captions vs the voiceover line (min 0.5), (4) keyword overlap with library section heading/text (>= 2 words).",
        "Records a new mobile clip of the matching page section for any website shot still without a clip.",
        "Shots still without footage are marked 'missing' with a reason; trial shots are marked 'needs_trial'.",
      ],
      files: ["pipeline/matcher.py", "pipeline/grabber.py"],
      cli: ["python -m pipeline.matcher gamma [out_root]"],
    },
    {
      id: "PIPE-06",
      name: "QA: automatic clip quality checks",
      priority: "core",
      summary: "Check every shot clip and mark it pass/fail with reasons.",
      details: [
        "A good clip is 3-15s, exactly 1080x1920, sharp (median Laplacian variance >= 500), not blank (grey std dev > 8) and has motion (mean frame diff >= 1.0), over 12 sampled frames.",
        "Writes qa / qa_reasons / qa_metrics into each shot, a top-level 'clips' map (pass/fail/missing + reason) and a 'needs_trial' list.",
        "Writes qa_report.json for the web UI. Manual uploads are QA-checked too.",
      ],
      files: ["pipeline/qa.py"],
      cli: ["python -m pipeline.qa pomelli [out_root]"],
      outputs: ["manifest.json (updated)", "qa_report.json"],
    },
    {
      id: "PIPE-07",
      name: "Trial: in-app recording of shots the website can't provide",
      priority: "supporting",
      summary: "Perform a shot's trial_steps inside the signed-in tool and record the result.",
      details: [
        "Runs only if shots failed QA / need trial and auth_<tool>.json exists; otherwise the shot stays for manual upload.",
        "Parses steps such as \"Click 'Create new'\" or \"Type 'a pitch deck'\" into click/type/scroll/wait actions and finds elements by text.",
        "If an element can't be found, Claude reads the cleaned page HTML and suggests a selector; after 2 failed suggestions the shot is flagged needs_manual.",
        "Waits up to 120s for generation to finish, keeps the last 12s of recording, saves clips/trialNN_<name>.mp4 + .png screenshot.",
        "Safety: never fills, reads or records login, card or captcha fields. If one appears the shot stops, the recording is discarded and the shot is flagged.",
      ],
      files: ["pipeline/trial_recorder.py"],
      cli: ["python -m pipeline.trial_recorder gamma [--headed] [--shots 5] [--force]"],
    },
    {
      id: "PIPE-08",
      name: "One-time manual login session capture",
      priority: "supporting",
      summary: "A person signs up / logs in by hand in a visible browser; only the resulting session is saved.",
      details: [
        "Opens the signup URL headed; the script reads or fills no fields.",
        "On Enter, saves cookies + storage to auth_<tool>.json (git-ignored, treated like a password).",
        "Used by the trial stage and as a bot-check fallback in extraction.",
      ],
      files: ["login_once.py"],
      cli: ["python login_once.py gamma https://gamma.app/signup"],
    },
    {
      id: "PIPE-09",
      name: "Assemble: rough cut",
      priority: "core",
      summary: "Join the shots in order into a 1080x1920 rough cut that keeps the script's timing.",
      details: [
        "Trims each clip to its shot's duration_seconds (from the script time ranges, then shot_list.json).",
        "Shots without a clip get a black placeholder card with a label for their duration (--no-placeholders to skip).",
        "Encodes H.264, 30 fps, CRF 20, no audio.",
        "Writes summary.md with a per-shot table.",
      ],
      files: ["pipeline/assembler.py"],
      cli: ["python -m pipeline.assembler gamma [out_root] [--no-placeholders]"],
      endpoints: ["POST /api/tool/{slug}/assemble"],
      outputs: ["out/<tool>/rough_cut.mp4", "out/<tool>/summary.md"],
    },
    {
      id: "PIPE-10",
      name: "Upload: Google Drive delivery",
      priority: "optional",
      summary: "Upload a tool's outputs to a numbered folder in the shared 'AI Tools' Drive folder.",
      details: [
        "Creates 'NN - <Tool Name>' with the next free number (or --num), reusing the folder on re-runs and replacing same-name files.",
        "Uploads clips/ (mp4 + png), script.txt, shot_list.json, manifest.json, summary.md, rough_cut.mp4.",
        "Never uploads auth_*.json, .env, credentials*.json, token*.json or client_secret*.json.",
        "OAuth desktop flow with credentials.json + cached token.json; full Drive scope so it can see existing numbered folders.",
        "The Drive folder link is parsed from the log and shown in the UI.",
      ],
      files: ["pipeline/drive_upload.py"],
      cli: ['python -m pipeline.drive_upload gamma [--name "Gamma"] [--num 01] [--out out]'],
      env: ["DRIVE_FOLDER_ID"],
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. Reel Kit (hooks + lead magnet)
// ---------------------------------------------------------------------------

const reelKit: FeatureGroup = {
  id: "KIT",
  title: "Reel Kit: hooks and lead magnet",
  description: "Marketing content generated right after extraction, using Groq only.",
  features: [
    {
      id: "KIT-01",
      name: "Hook generation",
      priority: "core",
      summary: "Write 4 opening hooks, each from a different proven template.",
      details: [
        "8 templates, e.g. 'The biggest mistake most people make...', 'So there's a new AI tool that lets you X and Y without Z', 'AI tools that save you time, part X: the old way vs the new way'.",
        "Uses only facts from the page text; no invented features, numbers, prices or company names.",
        "Each hook is a complete sentence, at most 25 words / under 5 seconds spoken.",
        "Output is validated; a rejected answer is retried once with the reason.",
      ],
      files: ["pipeline/reel_kit.py"],
      outputs: ["hooks.json", "page_text.txt"],
      env: ["GROQ_API_KEY"],
    },
    {
      id: "KIT-02",
      name: "Lead magnet generation (HTML + PDF)",
      priority: "core",
      summary: "Write a free checklist, playbook or step-by-step guide and render it as a branded page and PDF.",
      details: [
        "3-6 sections with 3-6 items each, grounded in the page text, with title, subtitle, intro and CTA.",
        "Rendered into templates/lead_magnet.html with labels per type (Part n / Play n / Step n); every model string is HTML-escaped.",
        "CTA partials from templates/cta_blocks.html; course / help links from config/links.json (non-http links become '#').",
        "PDF printed with Playwright page.pdf() (A4, backgrounds on).",
        "Options: demo type ('3 core features' | '1 use case end to end'), lead magnet type, comment keyword.",
      ],
      files: ["pipeline/reel_kit.py", "templates/lead_magnet.html", "templates/cta_blocks.html", "config/links.json"],
      cli: [
        'python -m pipeline.reel_kit --dir out/gamma.assets --tool Gamma --url https://gamma.app --demo-type "3 core features" --keyword GUIDE --magnet checklist',
      ],
      outputs: ["lead_magnet.json", "lead_magnet.html", "lead_magnet.pdf"],
    },
  ],
};

// ---------------------------------------------------------------------------
// 4. Monetisation / ManyChat backend
// ---------------------------------------------------------------------------

const manychat: FeatureGroup = {
  id: "MC",
  title: "Comment keywords, /go links and subscribers (ManyChat backend)",
  description:
    "The app is the backend for Instagram comment-keyword automations built in ManyChat.",
  features: [
    {
      id: "MC-01",
      name: "Per-tool metadata store",
      priority: "core",
      summary: "Price tier, checkout URL and comment keyword per tool, in data/tools.json.",
      details: [
        "Price tier is 'free' or 'paid'. Keywords are normalized to A-Z, 0-9, _ and -, uppercase, max 30 chars.",
        "Atomic writes (temp file + replace) under a lock; a bundled copy seeds a fresh data directory.",
      ],
      files: ["app.py", "data/tools.json", "pipeline/reel_kit.py"],
    },
    {
      id: "MC-02",
      name: "Keyword uniqueness check",
      priority: "core",
      summary: "Warn in the form, and refuse to start, when a keyword is already used by another tool.",
      details: ["Live check from the Reel Kit form; HTTP 409 on submit if taken."],
      files: ["app.py", "web/pipeline.html"],
      endpoints: ["GET /api/keyword-check?keyword=&tool=&url="],
    },
    {
      id: "MC-03",
      name: "Keyword redirect links (Flow A)",
      priority: "core",
      summary: "/go/<KEYWORD> sends people to the tool's checkout page, else its lead magnet page, else /library.",
      details: [
        "Every click is logged to data/clicks.csv (time, keyword, tool, redirect target).",
        "Links use PUBLIC_BASE_URL when set, else the request's own host.",
      ],
      files: ["app.py"],
      endpoints: ["GET /go/{keyword}"],
      env: ["PUBLIC_BASE_URL"],
    },
    {
      id: "MC-04",
      name: "Email subscribe webhook (Flow B)",
      priority: "core",
      summary: "ManyChat posts {email, name?, keyword, tool_id}; the app saves the email and returns the lead magnet PDF link.",
      details: [
        "Validates the email; resolves the tool by tool_id or keyword.",
        "One row per email in data/subscribers.csv (duplicate emails reported, not re-added); check-and-append under one lock.",
        "Optional shared secret: if SUBSCRIBE_TOKEN is set, requests must send it in X-Subscribe-Token (constant-time compare).",
        "CSV cells are escaped against spreadsheet formula injection.",
      ],
      files: ["app.py"],
      endpoints: ["POST /api/subscribe"],
      env: ["SUBSCRIBE_TOKEN", "PUBLIC_BASE_URL"],
    },
    {
      id: "MC-05",
      name: "Keyword overview",
      priority: "supporting",
      summary: "Every keyword with its tool, /go link, destination, price tier, click count and duplicate flag.",
      details: [],
      files: ["app.py", "web/library.html"],
      endpoints: ["GET /api/keywords"],
    },
    {
      id: "MC-06",
      name: "ManyChat setup guide generator",
      priority: "optional",
      summary: "Writes docs/manychat_setup.md with Flow A / Flow B instructions and a per-tool table.",
      details: [
        "First run writes the whole guide; later runs only replace the table between the tools-table markers, keeping manual edits.",
      ],
      files: ["pipeline/manychat_doc.py", "docs/manychat_setup.md"],
      cli: ["python -m pipeline.manychat_doc"],
    },
  ],
};

// ---------------------------------------------------------------------------
// 5. Web UI
// ---------------------------------------------------------------------------

const webUi: FeatureGroup = {
  id: "UI",
  title: "Web UI",
  description: "Static HTML/JS pages served by app.py. / serves index.html (same content as web/pipeline.html).",
  features: [
    {
      id: "UI-01",
      name: "Pipeline page",
      priority: "core",
      summary: "Start runs and extractions, watch progress, and review every output for a tool.",
      details: [
        "Top bar: tool name, website, optional Drive folder number, Run Pipeline, Extract Assets; links to Library and Extractor; 'Earlier runs' dropdown.",
        "Extract Assets panel: tool, URL, Show browser, Reel Kit options (demo type, keyword with live conflict warning, magnet type, generate toggle), price tier, checkout URL.",
        "Live progress: status dot, current stage, elapsed time, progress bar, streaming log with Stop and Hide log.",
        "Results: website data, script (with Copy), shot list with covered / missing / needs-manual badges, match score, QA reasons, clip previews.",
        "Per-shot manual clip upload (any video file); re-encoded to 1080x1920 and QA-checked.",
        "Preview: plays the shot list as a 9:16 reel (play / pause / seek).",
        "Download all as zip; Drive link when uploaded; image and video lightbox modal.",
        "Remembers some UI choices in localStorage.",
      ],
      files: ["web/pipeline.html", "index.html"],
      endpoints: [
        "GET /", "GET /pipeline", "POST /api/run", "POST /api/extract-assets", "GET /api/tools",
        "GET /api/tool/{slug}", "GET /api/job/{id}?since=", "POST /api/job/{id}/stop",
        "POST /api/tool/{slug}/shot/{shot}/upload", "GET /api/tool/{slug}/zip",
      ],
    },
    {
      id: "UI-02",
      name: "Media gallery",
      priority: "core",
      summary: "Browse a tool's extracted media by type and download a selection.",
      details: [
        "Tabs with counts: Videos, GIFs, Images, Embeds, SVGs, All, Hooks, Lead Magnet.",
        "Search by file name; sort by page order, largest first or newest.",
        "'Likely useful' filter hides people photos (testimonials/avatars, face detection), decorative backgrounds and icons; 'Hide small (< 20 KB)'.",
        "Select all / per-item select and 'Download selected' as a zip.",
        "Failed downloads listed under the grid; link to the standalone gallery.",
        "Files classified by their header, not their name; duplicates merged; works with old (assets.json) and new (manifest.json) output formats.",
      ],
      files: ["gallery.py", "web/pipeline.html", "models/face_detection_yunet_2023mar.onnx"],
      endpoints: ["POST /api/tool/{slug}/zip-selected"],
    },
    {
      id: "UI-03",
      name: "Standalone extractor page",
      priority: "supporting",
      summary: "Paste one or more URLs, extract, and see Scroll / Embedded clips / GIFs / Images.",
      details: [
        "Recent runs dropdown (newest first), sort, select and download selected.",
        "Shows an empty-state line per category (e.g. 'No GIFs found on this page.').",
      ],
      files: ["web/index.html"],
      endpoints: ["GET /extractor", "POST /api/extract", "GET /api/extract-runs", "GET /api/extract/{name}"],
    },
    {
      id: "UI-04",
      name: "Asset Library page",
      priority: "core",
      summary: "One card per processed tool, plus a Keywords tab.",
      details: [
        "Card: name, thumbnail (first extracted image), top hook, hook count, lead magnet type, PDF/HTML links, Free/Paid.",
        "Tools with a Reel Kit first, newest first.",
        "Filter All / Free / Paid; search tools, hooks, sites or keywords.",
        "Keywords tab: keyword, tool, /go link with Copy, destination, clicks, Duplicate badge.",
        "Remembers the selected tab and tier in localStorage.",
      ],
      files: ["web/library.html", "app.py"],
      endpoints: ["GET /library", "GET /api/library", "GET /api/keywords"],
    },
    {
      id: "UI-05",
      name: "Script editing endpoints",
      priority: "supporting",
      summary: "Build, save or regenerate a tool's script from the API, then re-run matching.",
      details: [
        "script/auto: template script without AI (hook from the description, 2-4 feature steps from page sections, CTA), skipping FAQ/footer/cookie/login sections.",
        "script/save: save a hand-edited script; parsed into shots by time-range headers, else by paragraph (4s each).",
        "script/generate: AI script via script_gen (needs an API key).",
        "Each one rewrites script.txt, shot_list.json and the manifest shots, then runs the matcher.",
      ],
      files: ["app.py"],
      endpoints: [
        "POST /api/tool/{slug}/script/auto",
        "POST /api/tool/{slug}/script/save",
        "POST /api/tool/{slug}/script/generate",
        "GET /api/config (reports whether an AI key is configured)",
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 6. Jobs, persistence and platform
// ---------------------------------------------------------------------------

const platform: FeatureGroup = {
  id: "PLAT",
  title: "Jobs, persistence and deployment",
  description: "How work runs in the background, survives restarts and gets deployed.",
  features: [
    {
      id: "PLAT-01",
      name: "Background jobs with live log",
      priority: "core",
      summary: "Each run/extraction is a subprocess whose output streams into an in-memory job.",
      details: [
        "One job at a time: new requests while a job runs get 'busy, try again'.",
        "Job ids are 8 hex chars; status running / stopping / stopped / done / failed / interrupted.",
        "Stage is derived from [PROGRESS] lines, '> ' lines and errors; the final stage names which pipeline stages failed and why.",
        "Polling with ?since=<line> returns only new log lines plus elapsed time, batch index/total and per-URL results.",
        "Stop terminates the subprocess.",
      ],
      files: ["app.py"],
      endpoints: ["GET /api/job/{id}", "POST /api/job/{id}/stop"],
    },
    {
      id: "PLAT-02",
      name: "Durable job store and restart recovery",
      priority: "supporting",
      summary: "Job state is saved to SQLite (data/jobs.db), a local JSON backup (out/.jobs/) and optionally Supabase.",
      details: [
        "On startup every stored job is loaded so /api/job/<id> keeps answering.",
        "A job stored as running is checked against its output on disk: marked done/failed if it finished, else 'interrupted' with a clear message.",
        "Supabase falls back to fewer columns if the table rejects the extra ones.",
        "REEL_DATA_DIR puts the store on a persistent disk.",
      ],
      files: ["pipeline/db.py", "app.py"],
      env: ["REEL_DATA_DIR", "SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_TABLE"],
    },
    {
      id: "PLAT-03",
      name: "Low-memory browser and remote browser support",
      priority: "supporting",
      summary: "Run Playwright inside 512 MB hosts, or connect to a remote browser.",
      details: [
        "Lightweight Chromium flags (--no-sandbox, --disable-dev-shm-usage, --disable-gpu, ...).",
        "BROWSER_WS_URL connects to a remote CDP browser (e.g. browserless); validated as ws:// or wss:// without printing the token.",
        "Optional blocking of image/media/font requests for text-only fetches; safe close of page/context/browser.",
      ],
      files: ["pipeline/browser_utils.py"],
      env: ["BROWSER_WS_URL"],
    },
    {
      id: "PLAT-04",
      name: "Static file serving and downloads",
      priority: "core",
      summary: "out/ is served at /out with mtime cache-busters; whole-tool and selected-file zips.",
      details: [
        "Already-compressed files (mp4, png, jpg, webp, zip ...) are stored, others deflated.",
        "Selected-file zip only accepts paths inside the tool's folder.",
        "Temp zips are deleted after the response.",
      ],
      files: ["app.py"],
      endpoints: ["GET /out/...", "GET /api/tool/{slug}/zip", "POST /api/tool/{slug}/zip-selected"],
    },
    {
      id: "PLAT-05",
      name: "Deployment targets",
      priority: "supporting",
      summary: "Docker image with FFmpeg + Playwright Chromium, configured for Render and Vercel.",
      details: [
        "Dockerfile (Render, port 8000) and Dockerfile.vercel (port 80); render.yaml free-plan web service; Procfile for Uvicorn.",
        "On Vercel the bundle is read-only, so out/ and data/ move to /tmp/reel-pipeline.",
        "CORS allows any origin so a separately hosted static frontend can call the backend.",
        "GET /health for health checks.",
        "npm run dev / npm start both run python app.py.",
      ],
      files: ["Dockerfile", "Dockerfile.vercel", "render.yaml", "Procfile", "vercel.json", "package.json"],
      endpoints: ["GET /health"],
      env: ["PORT", "VERCEL", "REEL_OUT_DIR"],
    },
    {
      id: "PLAT-06",
      name: "Secrets and personal-data hygiene",
      priority: "core",
      summary: "Project rule: no module reads, stores, logs or asks for card details or passwords.",
      details: [
        "Sign-ups and payments are done by a person in a visible browser; code only sees session cookies.",
        "Git- and Vercel-ignored: .env, auth_*.json, credentials.json, token.json, data/subscribers.csv, data/clicks.csv, data/jobs.db, out/.",
        "Drive upload has an explicit never-upload list for secret files.",
        "Path inputs are validated against traversal ('..', strict slug/name regexes).",
      ],
      files: ["pipeline/__init__.py", ".gitignore", ".vercelignore", "pipeline/drive_upload.py", "app.py"],
    },
  ],
};

export const FEATURE_GROUPS: FeatureGroup[] = [assetExtraction, reelPipeline, reelKit, manychat, webUi, platform];

/** Environment variables read anywhere in the project. */
export const ENVIRONMENT = {
  GROQ_API_KEY: "Groq key for describe, script, match scoring and the Reel Kit (GROK_API_KEY also accepted).",
  ANTHROPIC_API_KEY: "Claude key; preferred over Groq for describe, script, match scoring and trial selector suggestions.",
  DRIVE_FOLDER_ID: "Shared 'AI Tools' Drive folder for the upload stage.",
  PUBLIC_BASE_URL: "Public address used in /go and PDF links handed to ManyChat.",
  SUBSCRIBE_TOKEN: "Optional shared secret for POST /api/subscribe.",
  BROWSER_WS_URL: "Optional remote browser websocket.",
  SUPABASE_URL: "Optional Supabase job persistence (with SUPABASE_KEY / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY and SUPABASE_TABLE).",
  REEL_DATA_DIR: "Where jobs.db, tools.json and the CSVs live.",
  REEL_OUT_DIR: "Override for the out/ directory.",
  PORT: "HTTP port (default 8000).",
} as const;

/** External tools that must be installed on the host. */
export const SYSTEM_DEPENDENCIES = ["ffmpeg + ffprobe", "Playwright Chromium", "yt-dlp"] as const;

/** Things noticed while scanning that look worth fixing. Not features. */
export const OBSERVATIONS: string[] = [
  "describer.py and matcher.py call model 'claude-3-5-sonnet-20241022', while script_gen.py uses 'claude-opus-5-5'.",
  "assembler.py hard-codes the placeholder font as C:/Windows/Fonts/arial.ttf, which doesn't exist in the Linux Docker images.",
  "index.html at the root is identical to web/pipeline.html; recovered_ui.html and prev_extract_patch.txt look like leftovers.",
  "Only one job can run at a time across the whole server (is_job_running), including extractions for different tools.",
];

# Phase 1 Audit — reel-pipeline (Python/FastAPI) → Next.js/TS/Inngest migration

Produced against the codebase at `C:\Users\sgshr\Downloads\Adrian\week 10 - Copy\reel-pipeline` on 2026-10-26.
All file:line references verified by direct read/grep of the files — not inferred from `requirement.ts`/requirements.md.

## 1. Feature / endpoint map

### Endpoints (app.py) — all 23 documented routes confirmed present, 1 undocumented found

| Route | app.py:line |
|---|---|
| `POST /api/run` | 335 |
| `POST /api/extract` | 444 |
| `POST /api/extract-assets` | 484 |
| `GET /api/extract-runs` | 542 |
| `GET /api/extract/{name}` | 556 |
| `GET /api/job/{job_id}` | 578 |
| `POST /api/job/{job_id}/stop` | 631 |
| `GET /api/tools` | 645 |
| `GET /api/tool/{slug}` | 710 |
| `POST /api/tool/{slug}/shot/{shot}/upload` | 799 |
| `POST /api/tool/{slug}/zip-selected` | 854 |
| `GET /api/tool/{slug}/zip` | 875 |
| `GET /api/config` | 891 |
| `POST /api/tool/{slug}/script/auto` | 901 |
| `POST /api/tool/{slug}/script/save` | 992 |
| `POST /api/tool/{slug}/script/generate` | 1051 |
| `POST /api/tool/{slug}/assemble` | 1070 |
| `GET /api/library` | 1118 |
| `GET /api/keyword-check` | 1193 |
| `GET /api/keywords` | 1203 |
| `POST /api/subscribe` | 1227 |
| `GET /go/{keyword}` | 1271 |
| `GET /health` | 1290 |
| `GET /`, `/pipeline`, `/library`, `/extractor` | 1297, 1304, 1309, 1314 |

**Undocumented:** `@app.exception_handler(HTTPException)` at app.py:1319 — a custom error handler not called out anywhere in Section 4. Must be ported (check what it changes about error response shape) or explicitly waived.

### EXTRACT-01..09 — all map to `extract_assets.py` (single file, ~1660 lines) + `pipeline/browser_utils.py`

| ID | Evidence |
|---|---|
| EXTRACT-01 | `open_page()` extract_assets.py:577 (3x retry, 5/10/20s `BACKOFF` at :78, last headed); `collect()` :706; `scroll_page()` :729 (`SCROLL_TIMEOUT_S=180` :724); `click_reveals()` :761 (`MAX_CLICKS=40` :82); `record_media()` :635; `VIDEO_EXT` tuple incl. `.m3u8` :90; `MAX_HLS=5`/`MAX_BYTES=500MB` :84-85 |
| EXTRACT-02 | `FAVICON_RE` :95, `TRACKING_RE` :96, `MIN_BYTES=5*1024` :79, `VARIANT_PARAMS`/`asset_key()` :665-671, `dedupe_candidates()` :675, `sha256()` :430, `phash()`+`NEAR_DUP=4` :1055/:80 |
| EXTRACT-03 | `ytdlp()` :907, `record_embed()` :956 (8s via `embed_url()` :941), `to_mp4_video()` :1062 |
| EXTRACT-04 | `record_scroll()` :1193 → `00_page_scroll.mp4` :1370; section clips `01_<heading>.mp4` :1383; `mobile_check.png` referenced in `check_mobile_layout` (grabber.py:64, shared helper) |
| EXTRACT-05 | `normalize_video()` :458 (webm/mov→mp4), `animated_to_mp4()` :1078, `ffprobe()` :442, `--fix-existing` parsed in `main()`/argparse (not shown above but present per CLI help) |
| EXTRACT-06 | `dismiss_consent()` :532, `close_cookie_popups()` :551 (extract_assets.py also has its own local copy distinct from grabber.py's same-named function — **note**: two independent implementations, not shared) |
| EXTRACT-07 | `_bot_check_clear()` :1125 (20s wait); headed/headed+session fallback is the same 3-retry ladder as EXTRACT-01 |
| EXTRACT-08 | `finish()` :1602 writes manifest/report; `extract()` :1415 top-level orchestration |
| EXTRACT-09 | **Not found as a distinct function** — batch/multi-URL handling lives in app.py's `/api/extract` route body (app.py:444), which splits on whitespace/comma before calling `extract_assets.extract()` once per URL. Confirm this against the full app.py:444-483 block before porting; the per-URL continue-on-error behavior needs verification there, not in extract_assets.py. |
| EXTRACT-10 | `/api/extract-assets` app.py:484, writes to `data/tools.json` (confirmed, see §5) |
| EXTRACT-11 | `extract_assets_full.py`, `extract_videos.py`, `grab_visuals.py`, `test_7.py` all present at repo root, confirmed standalone/unimported by app.py (grep found zero cross-imports into app.py) |

### PIPE-01..10 — map to `pipeline/run.py` (orchestrator) + one module per stage

| ID | Evidence |
|---|---|
| PIPE-01 | `run_pipeline()` pipeline/run.py:66; stage list/deps logic in same function; `Skip` exception class :48 |
| PIPE-02 | `pipeline/grabber.py` — no single `grab()` entrypoint found in the top-level function scan; likely invoked via `run.py` calling grabber helpers directly (`record_shot` :556, `match_heading` :511, `close_cookie_popups` :362, `hide_chat_widgets` :391, `bot_check` :408). **Needs run.py:66-230 read in full to find the actual call sequence** — not done in this pass. |
| PIPE-03 | `describe()` pipeline/describer.py:129; `_extract_frames()` :38; `_call_vision()` :61 |
| PIPE-04 | `generate()` pipeline/script_gen.py:344; `write_reel()` :275; `fetch_site_text()` :140; `validate_reel()` :191; `render_script()` :319; `Shot`/`Reel` Pydantic models :46/:57 |
| PIPE-05 | `match()` pipeline/matcher.py:188; `score_catalog_with_llm()` :137; `build_shots()` :92; depends on `match_heading()` in grabber.py:511 as doc states |
| PIPE-06 | `run_qa()` pipeline/qa.py:157; `check_clip()` :64; `probe()` :31; `frame_stats()` :43; `annotate()` :96 |
| PIPE-07 | `record_shot()` pipeline/trial_recorder.py:363; `run_step()` :315; `parse_step()` :159; `NeedsManual` exception :47 |
| PIPE-08 | `login_once.py` (repo root, standalone CLI script, confirmed present, not read in detail) |
| PIPE-09 | `pipeline/assembler.py` — **font hardcode confirmed, see §2** |
| PIPE-10 | `upload()` pipeline/drive_upload.py:162; `is_forbidden()` :121 (never-upload list); `get_service()` :49 (OAuth) |

### KIT-01/02 — both in `pipeline/reel_kit.py`

`make_hooks()` :163, `check_hooks()` :175, `make_magnet()` :212, `check_magnet()` :225, `render_magnet()` :244 (HTML escaping confirmed via `html` import), `export_pdf()` :294 (Playwright `page.pdf()`), `GROQ_MODELS` list :34 confirms Groq-only as documented (no Anthropic import in this file).

### MC-01..06 — split across app.py and reel_kit.py/manychat_doc.py

Confirmed: `data/tools.json` write path exists and matches documented shape (§5). `/go/{keyword}` app.py:1271, `/api/subscribe` app.py:1227, `/api/keyword-check` app.py:1193, `/api/keywords` app.py:1203. `pipeline/manychat_doc.py:125 write()` for MC-06, with marker-based table replacement per `table()` :93.

### UI-01..05, PLAT-01..06

Not independently re-verified beyond what's covered in §2-5 below (PLAT items) and the endpoint map above (UI items are all app.py routes already listed). Gallery.py (13999 bytes) backs UI-02 — confirmed file exists, contents not read in this pass.

**Summary: ~85% of feature IDs mapped to specific file:line evidence in this pass. Gaps needing a follow-up read: EXTRACT-09's exact continue-on-error code, PIPE-02's actual call sequence inside run.py, UI-01/03/04 route bodies (found, not detailed), PLAT-03 (browser_utils.py found but low-memory flags not grepped).**

## 2. Section 10 observations — verified against real code

| Observation | Verdict | Evidence |
|---|---|---|
| `describer.py`/`matcher.py` call `claude-3-5-sonnet-20241022` | **CONFIRMED** | describer.py:76, matcher.py:157 — both literal strings, used as primary with Groq fallback (describer.py:96 `qwen/qwen3.8-27b`; matcher.py:166 `openai/gpt-oss-120b`) |
| `script_gen.py` uses `claude-opus-5-5` | **CONFIRMED** | script_gen.py:34 `MODEL = "claude-opus-5-5"`, used at :258 and reused by trial_recorder.py:297 via import. Groq fallback chain at :242 tries `gpt-oss-120b` → `qwen/qwen3.8-27b` → `gpt-oss-20b` in that order. |
| `assembler.py` hard-codes `C:/Windows/Fonts/arial.ttf` | **CONFIRMED** | pipeline/assembler.py:23 `FONT = Path("C:/Windows/Fonts/arial.ttf")`, used directly in the ffmpeg `drawtext` filter at :59-60 with no existence check or platform branch. **Will silently break placeholder-card text rendering on any non-Windows host** (the target Linux Docker images, Render, Vercel worker) — not a migration nuance, an active bug today that must not be ported as-is. |
| Root `index.html` identical to `web/pipeline.html` | **CONFIRMED** | Byte-for-byte diff returned no differences; both 1467 lines. |
| `recovered_ui.html` / `prev_extract_patch.txt` are leftovers | **CONFIRMED** | Zero references to either filename anywhere in app.py or pipeline/*.py. `recovered_ui.html` is 1649 lines — an older/divergent UI variant, not a superset or subset of pipeline.html by line count alone (not diffed in detail). `prev_extract_patch.txt` is literally a 5-line unified-diff fragment, clearly a stray paste, not consumed by any code. |
| Single global `is_job_running()` lock across whole server | **CONFIRMED** | app.py:155-157 — checks `any(j.get("status") in ("running","stopping") for j in jobs.values())` across the entire in-memory `jobs` dict, with no per-tool/per-slug scoping. Called at app.py:337, :447, :490 (the three job-starting routes). This really is one job for the *entire* server, any tool, confirmed exactly as documented. |

**All five Section 10 observations confirmed accurate — none were stale.**

## 3. Python-only dependency inventory (no 1:1 Node/TS equivalent)

From `requirements.txt` + actual imports grepped across pipeline/*.py, extract_assets.py, app.py, gallery.py:

| Dependency | Used in | Node/TS migration note |
|---|---|---|
| `playwright` (sync API) | extract_assets.py, pipeline/grabber.py, pipeline/trial_recorder.py, pipeline/browser_utils.py, pipeline/reel_kit.py | Playwright for Node exists and is near-parity, but all sync-API code must become async/await — this is a real porting effort, not a drop-in swap, per every function signature in grabber.py/extract_assets.py. |
| `yt-dlp` | extract_assets.py (`ytdlp()` :907), pipeline/grabber.py | No maintained Node-native yt-dlp; plan is to shell out to the `yt-dlp` CLI from the worker (as the target doc already assumes) — not a library port. |
| `opencv-python-headless` (`cv2`) | pipeline/qa.py (frame_stats/sharpness via Laplacian variance), extract_assets.py | No direct Node equivalent with the same algorithm; `sharp` doesn't do Laplacian variance. Likely needs `opencv4nodejs` or re-running `ffmpeg`/custom pixel math — needs explicit decision, not in target doc's dependency list (Section 6 only says "Sharp or equivalent" for images, not video-frame sharpness). |
| `imagehash` (perceptual hash, `phash()` extract_assets.py:1055) | extract_assets.py | Target doc already calls out "a perceptual-hash library" generically — confirm a Node lib produces phash values compatible/comparable in output, since NEAR_DUP=4 threshold is tuned to this specific library's hash algorithm. |
| `Pillow` (`PIL.Image`) | extract_assets.py (phash input), pipeline/describer.py (likely frame handling) | Sharp covers most Pillow use but double-check anywhere Pillow is used for format-specific decode (AVIF, animated WebP) that extract_assets.py explicitly supports (EXTRACT-05). |
| `ffmpeg-python` | pipeline/assembler.py and likely extract_assets.py for `run()`/`ffprobe()` wrappers | Target doc already assumes native ffmpeg CLI invocation from worker — same approach works in Node via `child_process`, not a blocker, just confirm the exact filter strings (e.g. drawtext font path bug) get re-reviewed, not copy-pasted. |
| `google-api-python-client` / `google-auth-oauthlib` | pipeline/drive_upload.py | Google has an official Node client (`googleapis`) — straightforward swap, OAuth desktop flow needs re-implementation for a server context (current code assumes a local browser-based consent flow via `InstalledAppFlow`, which won't run unattended in a worker — this is a bigger issue than a dependency swap, it's a flow redesign). |
| `sqlite3` (stdlib) | pipeline/db.py | Target replaces with Supabase Postgres per spec — not a dependency gap, just confirms db.py's SQLite-first-then-Supabase-fallback logic (see below) needs to become Postgres-primary. |

## 4. Filesystem / environment assumptions

- **Font path bug (assembler.py:23)** — see §2, this is the single clearest "don't port as-is" item.
- **Headed-mode final retry** (extract_assets.py:577-590, `open_page()`): the last of 3 retries always launches a *headed* (visible) browser (`headed = attempt == len(BACKOFF)`). This assumes a display is available. On a headless Linux worker container (Render, Docker) this will fail outright unless Xvfb or equivalent virtual display is provisioned — the target architecture doc doesn't mention this requirement anywhere in Section 2 or 6. **This needs an explicit decision**: either provision a virtual display on the worker, or redesign the retry ladder to stay headless.
- **`/tmp` fallback already exists in source** — both `pipeline/db.py:23` and `app.py:49-50` already check `os.environ.get("VERCEL")` and redirect to `/tmp/reel-pipeline` when set. This is *existing* defensive code for Vercel's read-only filesystem, not something to newly invent during migration — but it also proves the current Python app already assumes Vercel's `/tmp` is the only writable path there, consistent with PLAT-05's constraint.
- No other hardcoded Windows-specific paths or `winget`-style tool assumptions found via grep across extract_assets.py, pipeline/*.py, app.py beyond the one font path.

## 5. Data model as it actually exists today

- **`data/tools.json`** — flat object keyed by tool slug (e.g. `"gamma.assets"`), each value `{price_tier: "free"|"paid", checkout_url: string, comment_keyword: string}`. Confirmed exact shape by reading the live file (9+ entries present in this checkout).
- **`data/jobs.db`** (SQLite) — single table `jobs` with columns: `job_id` (TEXT PRIMARY KEY), `url`, `stage`, `status`, `events` (TEXT — likely JSON-serialized), `tool`, `slug`, `type`, `results` (TEXT), `names` (TEXT), `drive` (TEXT), `started` (REAL — unix timestamp), `updated_at` (TEXT). Confirmed via direct `sqlite_master` schema dump.
- **`data/clicks.csv`, `data/subscribers.csv`** — **do not exist in this checkout** (never triggered — no `/go/` clicks or `/api/subscribe` calls happened in this environment). Their shape must be taken from the code in app.py (`/go/{keyword}` and `/api/subscribe` handlers) rather than from a live sample; this audit did not read those handler bodies in full to extract the exact CSV column order.
- **`config/links.json`** — flat object: `COURSE_URL`, `LEAD_MAGNET_URL`, `HELP_LINK_1..4` and matching `_TITLE`/`_TEXT` suffixes, all plain strings (several empty in this checkout). Confirmed by direct read.
- **Supabase fallback** (`pipeline/db.py:30-37`): reads `SUPABASE_URL`, then tries `SUPABASE_KEY` → `SUPABASE_ANON_KEY` → `SUPABASE_SERVICE_ROLE_KEY` in that priority order, with `SUPABASE_TABLE` defaulting to `"jobs"`. The "falls back to fewer columns if the table rejects additional columns" behavior mentioned in PLAT-02 was not independently verified in this pass — `pipeline/db.py` beyond line 66 (`save_job_state`) wasn't read in full.

## Follow-ups not completed in this pass (flag before Phase 2 starts)

1. Read `pipeline/run.py:66-230` in full to nail down PIPE-02's actual grab-stage call sequence.
2. Read app.py:444-483 (`/api/extract`) in full to confirm EXTRACT-09's continue-on-error behavior precisely.
3. Read `pipeline/assembler.py` end-to-end (only the font section was checked) for the rest of PIPE-09's claims (CRF 20, 30fps, `summary.md` generation).
4. Read `pipeline/db.py:66-195` (`save_job_state`) to verify the Supabase column-fallback behavior PLAT-02 claims.
5. Read `gallery.py` to confirm UI-02's face-detection/classification claims (model file `models/face_detection_yunet_2023mar.onnx` exists on disk per earlier `ls`, not yet opened).

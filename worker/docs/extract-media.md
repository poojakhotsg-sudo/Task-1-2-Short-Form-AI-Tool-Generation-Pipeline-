# Asset extraction (EXTRACT-01..07) — first installment

`/tasks/extract_media`'s real implementation, ported from
`extract_assets.py`'s `extract()`/`_extract()` (lines 1415-1696) and the
functions it calls. This is a ~1900-line, multi-concern CLI tool — far
larger than any other single task in this project. Before starting, the
user was asked how deep to go and confirmed "everything, understood as
multi-turn." This is the first installment: the core page-scan →
download → categorize → manifest pipeline, faithfully ported, with four
genuinely separate subsystems explicitly deferred (listed below, not
silently dropped). Four follow-up turns have since closed three of
those four, plus one originally-permanent simplification (non-GIF
animated image conversion, described below): perceptual-hash
near-duplicate detection, HLS (`.m3u8`) downloads, iframe/embed
recording, and animated WebP/APNG/AVIF conversion.

## What this does

Given a URL:

1. **Loads the page** as an iPhone 14 (390x844), retrying up to 3 times
   with 5/10/20s backoff, the final attempt headed — `openPageWithRetry()`
   in `extractMedia.ts`, ported from `open_page()`. Detects a bot-check
   page by scanning title+body text for `BOT_RE` matches.
2. **Collects candidate media URLs** three ways, same as the source:
   DOM scanning (`img`/`video`/`iframe`/SVG/shadow-root elements, plus
   CSS background-images on later passes — `collect.ts`'s
   `COLLECT_DOM_JS`, verbatim from the source), scroll-triggered lazy
   loading (`scrollPage()`), and click-reveals (tabs, carousel-next
   buttons, "show more" buttons — `clickReveals()`). A network-response
   listener (`recordMedia()`) also catches media the page requested but
   never rendered.
3. **Dedupes candidates** by asset identity — same URL differing only in
   a size/format/tracking query param collapses to one, keeping the
   largest variant (`dedupeCandidates()` in `pure.ts`).
4. **Downloads** each non-iframe candidate with the page's cookies,
   referer, and user agent (`download.ts`), including `data:` URLs and
   HLS (`.m3u8`) media — ffmpeg-remuxed first, falling back to the
   `yt-dlp` CLI when the remux fails or is too small (`hls.ts`'s
   `downloadHls()`, see below). Every iframe candidate matching
   `EMBED_RE` (YouTube/Vimeo/Loom/Wistia/etc.) gets its own attempt:
   `yt-dlp` first, falling back to actually playing it muted in a fresh
   headless browser and recording 8 seconds (`embed.ts`'s
   `downloadOrRecordEmbed()`, see below).
5. **Inspects** each download via `ffprobe` (`inspect.ts`) to classify
   it: video, animated image, still image, SVG, or unusable ("other").
   Filters out favicons, tracking pixels, and stills under 150px or
   5KB, exactly matching the source's thresholds.
6. **Converts and normalizes**: any video container → mp4
   (`convert.ts`'s `toMp4Video()`), a real GIF → mp4
   (`animatedGifToMp4()`), an animated WebP/APNG/AVIF → mp4 with white
   behind any transparency (`animatedToMp4()`, see below), then all of
   these get the same h264/yuv420p/+faststart pass PIPE-? / EXTRACT-05's
   `normalize_media` task already does (`normalizeVideoFile()`, reused
   directly — not duplicated).
7. **Dedupes** within each category — exact duplicates via sha256, then
   near-duplicates via a perceptual hash (`phash.ts`'s `computeDHash()`,
   see below for the one documented algorithm divergence) at the
   source's same `NEAR_DUP = 4` Hamming-distance threshold, with the
   source's aspect-ratio guard (`similarShape()`) for the images
   category — then sorts by page position and names each file by the
   nearest heading above it (`sectionFor()`/`slug()` in `pure.ts`).
8. **Writes** `manifest.json`, `report.json`, and every kept file under
   the job's `extract/` storage prefix (`videos_gifs/`, `images/`,
   `raw/` — object-storage-layout.md's existing convention).

## What is NOT ported in this pass — flagged, not silently dropped

1. **`record_scroll()`** — the mobile scroll-through video + per-section
   clips that give the source its "scroll" folder. A separate,
   substantial piece on its own: a bot-check-bypass retry ladder with a
   saved-auth-cookie fallback, custom eased-scroll pacing with
   section-heading pauses, hover simulation during section clips, and
   its own phash-deduped section clips (now reusable from phash.ts,
   and its clip-encoding step from convert.ts's encodeSegment() too,
   though record_scroll() itself still isn't ported).

## Perceptual-hash near-duplicate detection — ported, with one divergence

The source's `phash()`/`middle_frame()` use PIL to open the image (or
ffmpeg to grab a video's middle frame) and `imagehash.phash()` — a
DCT-based perceptual hash — to produce a 64-bit fingerprint, then
compares fingerprints with Hamming distance, treating anything within
`NEAR_DUP = 4` bits as the same asset (merging their page positions,
same as a sha256 exact match).

This worker has no Node image library (same reasoning as `inspect.ts`
below), so `phash.ts`'s `computeDHash()` computes a **difference hash
(dHash)** instead, via `extractGrayscaleFrameRaw()` — already built for
`qa/checkClip.ts` and reused here rather than duplicated: downscale to
9x8 grayscale, compare each row's adjacent pixels for 64 bits total.
dHash and phash are different algorithms and will not produce bit-
identical hashes for the same image; on genuinely borderline near-
duplicates (not exact pixel matches) they may occasionally disagree
with what the source's `imagehash.phash()` would have decided. The
64-bit size and `NEAR_DUP = 4` threshold carry over unchanged, since
both hashes are meant to be compared the same way. This is a
faithful-in-spirit, not bit-for-bit, port of this one piece — and it
IS wired into the same dedup pass sha256 runs in (`extractMedia.ts`'s
`categorizeAndPlace()`), scoped per asset "family" (video vs. animated
vs. still) exactly like the source's separate embedded/gifs/images
groups, plus the source's aspect-ratio guard (`similarShape()`) for the
images category only.

## HLS (`.m3u8`) downloads — ported

`download_hls()` (lines 880-891) is ported in `hls.ts`'s `downloadHls()`,
reached from `download.ts` either when a candidate's URL ends in
`.m3u8`, or when a plain GET's response content-type turns out to be an
HLS manifest despite the URL not saying so (both match the source's two
call sites for this function):

1. **ffmpeg remux first** — `-headers` carrying the page's referer/UA,
   `-c copy` (no re-encode — fast, works for most plain HLS streams),
   `-bsf:a aac_adtstoasc` (the standard fixup for muxing AAC-in-ADTS
   audio into an mp4 container), capped at the source's 300s timeout.
   Kept only if the result is over 10KB, same threshold as the source.
2. **`yt-dlp` fallback** — `ytdlp()` (lines 907-926) ported against the
   installed `yt-dlp` CLI rather than Python's `yt_dlp` library import
   (there's no Node equivalent to import; this worker already shells
   out to the `yt-dlp` CLI the same way for `fetch_site_text`'s embed-
   info lookup). Same format-selection string, same `noplaylist`/
   `playlist-items 1`/`retries 2`/`socket-timeout 20` options, same
   "biggest file matching the output stem, ignoring `.part`/`.ytdl`/
   `.json`/`.title`" pick.

Not carried forward: the source's side effect of saving yt-dlp's
reported video title to a `.title` file next to the download. Nothing
downstream of `download()`'s return value (`path, err`) in the source
ever reads that file, and nothing in this port's `downloadAsset()`
contract (`{ext, content} | {error}`) has anywhere to put a title either
— dropped as genuinely unused, not silently lost.

## iframe/embed recording — ported

`record_embed()`/`embed_url()`, and the embed loop inside
`download_all()` (lines 1578-1598) that ties them to `ytdlp()`, are
ported in `embed.ts`'s `downloadOrRecordEmbed()`. For every iframe
candidate `EMBED_RE` matched, deduped by resolved target URL (one
attempt per unique embed, same as the source's `seen` set):

1. **`embedUrl()`** normalizes YouTube/Vimeo/Loom embed `src`s to their
   canonical watch/share URLs (anything else passes through unchanged —
   `yt-dlp` has broad native support beyond this list).
2. **`yt-dlp` first** — `downloadViaYtdlp()`, the exact same function
   `hls.ts` uses for its HLS fallback (the source reuses one `ytdlp()`
   for both call sites too). On success, a lightweight follow-up
   `yt-dlp --print title` call gets the title for the manifest's
   `originalFilename` (the source gets this for free from the Python
   library's returned info dict; shelling out to the CLI means a second
   call for the same value — same pattern `fetch_site_text`'s embed-info
   lookup already uses).
3. **Browser recording as the fallback** — `recordEmbed()`: a fresh
   headless browser (own `chromium.launch()`, not the main scraping
   session — same as the source's own separate `launch_or_connect()`
   call here), muted autoplay at 1280x720, click + `PLAY_VIDEOS_JS` to
   nudge playback, record 8 seconds, then `convert.ts`'s `encodeSegment()`
   (ported from `encode_segment()`) cuts the segment out with the same
   wall-clock-vs-ffprobe-duration drift correction (`k` factor) the
   source computes.

Staged results carry through `categorizeAndPlace()`/`placeItem()` with
the source's exact distinctions: an `embed` or `embed_recording` item
normalizes with `is_embed: true` (keeps audio, unlike a plain
downloaded video), an `embed_recording` never gets a redundant `raw/`
copy of its own output, and its `originalFilename` reads "recorded
playing in the browser" instead of a real filename. The report's
`embeds` array (`{url, resolved, result}[]`, written to `report.json`)
mirrors the source's `state["embeds"]` list; `embedsNotDownloaded`
now counts only entries where both `yt-dlp` and the recording fallback
failed, not "every embed candidate" as in the pre-this-pass version of
this doc.

## Animated WebP/APNG/AVIF conversion — ported, without PIL

`animated_to_mp4()`'s non-GIF branch (lines 1085-1101) decodes the
image frame-by-frame via PIL's `ImageSequence` and pipes raw RGB into
ffmpeg's stdin, composited onto white — specifically because PIL was
already a dependency for other parts of that script, not because
ffmpeg itself can't decode these formats. Confirmed directly (`ffmpeg
-decoders`) rather than assumed: this worker's ffmpeg build has native
`webp_anim`/`apng` decoders, and decodes AVIF via its already-enabled
AV1 decoder (`libdav1d`/`libaom`). So `convert.ts`'s `animatedToMp4()`
skips PIL entirely — one `ffmpeg -i <src> -f lavfi -i color=white
-filter_complex "...scale2ref...overlay=shortest=1..."` command decodes
the source, composites it over a white background (`overlay` is
alpha-aware by default, matching PIL's `Image.alpha_composite()` onto a
white canvas), and encodes straight to h264. No new dependency, no
behavior gap: verified with a real semi-transparent animated WebP
before relying on it (the composited frame samples bright/near-white,
not black, confirming transparency isn't rendered as black) — see the
test coverage below.

One real gap, not silently glossed over: this worker's ffmpeg build
can *decode* any real animated AVIF (its AV1 decoder handles whatever
frame sequence the file has), but its AVIF *encoder* only produces
single-frame stills, so a genuine multi-frame AVIF couldn't be
generated locally to verify decoding end-to-end for that one format
the way the WebP/APNG tests do directly. The AVIF test instead confirms
the identical command decodes a real AV1-coded AVIF file and encodes a
playable mp4 — the per-frame mechanics are ffmpeg's demuxer/decoder's
job, not this code's, so a verified single frame and a verified
multi-frame WebP/APNG together cover what this function actually does.

## A real behavior difference from `inspect()` — not silent

The source's `inspect()` uses PIL to read image facts (dimensions,
format, animation frame count/timing) directly from decoded pixel data.
This worker has no Node image library, so `inspect.ts` re-bases the same
classification on `ffprobe` instead — which this worker already depends
on (Section 6). ffprobe decodes the same still-image formats PIL does
(JPEG/PNG/GIF/WEBP/AVIF, on a reasonably current ffmpeg build) and
reports frame counts for animated containers via `-count_frames`, which
is everything this pass's classification needs. What it does NOT
compute — per-frame GIF duration/fps — was never read by this port's
`animatedGifToMp4()`/`animatedToMp4()` either (both decode the source
file directly with ffmpeg, not frame-by-frame from facts this port
computed), so nothing in the actually-ported code needed it.

## Test coverage

- `extractMedia/__tests__/pure.test.ts` — `slug()`/`sectionFor()`/
  `guessExt()`/`isVideoUrl()`/`assetKey()`/`dedupeCandidates()`/
  `originalName()`/`humanBytes()`/`hammingDistance()`/`similarShape()`
  against synthetic inputs, no browser or ffmpeg needed.
- `extractMedia/__tests__/phash.ffmpeg.test.ts` — `computeDHash()`
  against real `ffmpeg`-generated images: deterministic (same image
  twice -> same hash), two very different images land well outside the
  `NEAR_DUP` threshold, two identical solid-color images land inside it,
  and a nonexistent file returns `null` rather than throwing; plus
  `middleFrameSeconds()`'s still-vs-duration branching.
- `extractMedia/__tests__/hls.ffmpeg.test.ts` — `downloadHls()` against
  a real local HTTP server serving a real ffmpeg-generated HLS playlist
  (ffmpeg's `-headers` option only applies to network protocols, so a
  genuine test needs a real server, not a local file path or a mock):
  the ffmpeg-remux path produces a playable mp4 from a real HLS stream,
  and an unreachable source correctly reports an error after both the
  remux and the `yt-dlp` fallback fail. The `yt-dlp` fallback's success
  path isn't independently exercised here — it needs a real downloadable
  remote URL, which would make this test flaky/network-dependent.
- `extractMedia/__tests__/embed.pure.test.ts` — `embedUrl()` against
  real YouTube/youtube-nocookie/Vimeo (with and without a private-video
  hash)/Loom embed `src` shapes, and an unrecognized provider passed
  through unchanged.
- `extractMedia/__tests__/convert.ffmpeg.test.ts` — `toMp4Video()`/
  `animatedGifToMp4()`/`animatedToMp4()`/`encodeSegment()` against real
  `ffmpeg`: a non-mp4 source actually ends up h264/yuv420p, an
  already-compliant source takes the cheap stream-copy path, a real
  animated GIF decodes to a playable mp4, a real animated WebP and a
  real APNG each decode to a playable mp4, a real AV1-coded AVIF
  decodes through the identical command (animated-AVIF decoding itself
  isn't independently verified — see the file-level comment on why),
  a semi-transparent WebP's composited frame samples bright/near-white
  rather than black (proving the white-behind-transparency compositing
  actually works, not just assumed from ffmpeg's docs), and
  `encodeSegment()` correctly cuts a sub-range (scaled or not) and
  reports failure for a nonexistent source.
- `extractMedia/__tests__/inspect.ffmpeg.test.ts` — `inspectAsset()`
  against real `ffprobe`-generated stills/GIFs/video and raw SVG/HTML
  byte sniffing: correct `kind` and `facts` for each, including the
  animated-vs-still GIF frame-count distinction.
- `extractMedia.route.test.ts` — the HTTP layer with the service
  mocked: request validation, uploading every file plus
  `manifest.json`/`report.json` under `storagePrefix`, the
  "N embed(s) not downloaded" message, the per-embed `{url, resolved,
  result}` detail round-tripping into `report.json`, an honest
  failed-extraction response (still writes `manifest.json`/
  `report.json`, no asset files), and error-path status codes.

`collect.ts`'s Playwright-dependent functions (`closeCookiePopups`,
`dismissConsent`, `collect`, `scrollPage`, `clickReveals`,
`recordMedia`), `embed.ts`'s `recordEmbed()`/`downloadOrRecordEmbed()`/
`fetchYtdlpTitle()`, and `extractMedia.ts`'s top-level orchestration
have no dedicated unit tests in this pass — same convention as
`captureSite.ts` and `siteText.ts`: real browser automation (and, for
`fetchYtdlpTitle()`, a real network call to a real video) with no local
fixture to drive it against.

## No web-next caller yet

Like `normalize_media`, nothing in `web-next` calls this yet. The
existing `POST /api/extract-assets` route (`web-next/src/app/api/
extract-assets/route.ts`) only emits the 8-stage reel-pipeline's `grab`
stage — EXTRACT-* numbering belongs to this separate, older asset-
extraction product, which Phase 3's reel pipeline doesn't orchestrate.
Wiring a caller is out of scope for this task; the HTTP contract and the
real work behind it are what matters here.

// Browser-side JS snippets and selector lists ported verbatim from
// extract_assets.py (lines 90-399). Kept separate from pure.ts because
// these are opaque strings evaluated in the page, not logic this file
// runs itself.

export const ASSET_DEVICE = 'iPhone 14';
export const ASSET_VIEWPORT = { width: 390, height: 844 };
export const NAV_TIMEOUT_MS = 45000;
export const BACKOFF_MS = [5000, 10000, 20000]; // 3 retries after the first try; the last one headed
export const MAX_SCROLL_STEPS = 120;
export const MAX_CLICKS = 40;
export const MAX_BYTES = 500 * 1024 * 1024;
export const MIN_STILL_BYTES = 5 * 1024;
export const SCROLL_TIMEOUT_S = 180;
export const SCROLL_STEP = 0.5;
export const SCROLL_WAIT_MS = 1000;
export const EMBED_REC_VIEWPORT = { width: 1280, height: 720 };
export const EMBED_REC_SECONDS = 8.0;

// extract_assets.py's EMBED_RE (line 92-94) — recognized iframe/anchor
// embed providers. Used to classify candidates AND to decide which
// iframe URLs get the yt-dlp-or-browser-recording treatment
// (embed.ts's downloadOrRecordEmbed(), called from extractMedia.ts).
export const EMBED_RE =
  /(youtube(-nocookie)?\.com\/(embed|watch|shorts)|youtu\.be\/|player\.vimeo\.com\/video\/|vimeo\.com\/\d+|loom\.com\/(embed|share)\/|wistia\.(com|net)\/(embed|medias)|wi\.st\/|supademo\.com\/|arcade\.software\/|storylane\.io\/|navattic\.com\/|vidyard\.com\/|streamable\.com\/|dailymotion\.com\/embed\/)/i;

export const COOKIE_SELECTORS = [
  '#onetrust-accept-btn-handler', '#accept-recommended-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept',
  '#didomi-notice-agree-button', '.osano-cm-accept-all', '#truste-consent-button', '.fc-cta-consent',
  ".qc-cmp2-summary-buttons button[mode='primary']", 'button#accept-cookies',
  "[data-testid*='cookie' i] button", '.cc-allow', '.cc-btn.cc-dismiss',
  "button[aria-label*='accept' i]", "button[aria-label*='agree' i]",
];

export const COOKIE_TEXT_RE =
  /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|consent|yes,? i agree|reject( all)?|decline)\s*$/i;

export const CAROUSEL_NEXT_SELECTOR = [
  "button[aria-label*='next' i]", "[role=button][aria-label*='next' i]", "button[aria-label*='forward' i]",
  "button[title*='next' i]", "[data-testid*='next' i]", '.swiper-button-next', '.slick-next',
  '.carousel-control-next', '.splide__arrow--next', '.flickity-prev-next-button.next', '.glide__arrow--right',
  "[class*='carousel' i] [class*='next' i]", "[class*='slider' i] [class*='next' i]", "[class*='arrow-right' i]",
].join(', ');

export const SHOW_MORE_RE = /^\s*(show|see|view|load|read)\s+(more|all)\b/i;

// Consent banners that wouldn't close: hide them and give the page its
// scrolling back (extract_assets.py's CONSENT_HIDE_JS, lines 122-132).
export const CONSENT_HIDE_JS = `() => {
  const sel = '#onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-host, .osano-cm-window, #truste-consent-track, ' +
              '.fc-consent-root, .qc-cmp2-container, [id*="cookie-banner" i], [class*="cookie-banner" i], ' +
              '[id*="consent-banner" i], [class*="consent-banner" i], [aria-label*="cookie" i][role="dialog"]';
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (el.offsetParent !== null || getComputedStyle(el).position === 'fixed') { el.style.setProperty('display', 'none', 'important'); n++; }
  }
  if (n) for (const el of [document.documentElement, document.body]) { el.style.overflow = 'auto'; el.style.position = ''; }
  return n;
}`;

export const PROMOTE_LAZY_JS = `() => {
  for (const img of document.querySelectorAll('img')) {
    img.loading = 'eager';
    for (const a of ['data-src', 'data-lazy-src', 'data-original']) {
      const v = img.getAttribute(a);
      if (v && !img.getAttribute('src')) img.setAttribute('src', v);
    }
  }
  for (const v of document.querySelectorAll('video[preload="none"]')) v.preload = 'metadata';
}`;

export const PLAY_VIDEOS_JS = `() => { for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}) } }`;

export const HEADINGS_JS = `() => [...document.querySelectorAll('h1, h2, h3, [role=heading]')]
  .filter(h => h.offsetParent !== null && (h.innerText || '').trim().length > 1)
  .map(h => ({y: Math.round(h.getBoundingClientRect().top + scrollY), text: h.innerText.trim().slice(0, 80)}))
  .sort((a, b) => a.y - b.y)`;

export const SCROLL_NESTED_JS = `async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const boxes = [...document.querySelectorAll('body *')].filter(el => {
    const cs = getComputedStyle(el);
    return ((/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 20) ||
            (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100));
  }).slice(0, 25);
  for (const el of boxes) {
    for (let i = 1; i <= 4; i++) {
      el.scrollLeft = el.scrollWidth * i / 4; el.scrollTop = el.scrollHeight * i / 4; await sleep(150);
    }
    el.scrollLeft = 0; el.scrollTop = 0;
  }
  return boxes.length;
}`;

// extract_assets.py's COLLECT_DOM_JS (lines 156-271), ported verbatim
// (img/video/iframe/svg/shadow-root scanning) — the single largest
// browser-side snippet in the source, deliberately not reinterpreted.
export const COLLECT_DOM_JS = `(withBg) => {
  const out = [], seen = new Set();
  const abs = u => { try { return new URL(u, location.href).href } catch (e) { return null } };
  const pos = el => { const r = el.getBoundingClientRect();
    return {y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height)} };
  const add = (u, kind, el) => {
    if (!u) return; u = abs(String(u).trim());
    if (!u || !/^https?:/.test(u)) return;
    const k = kind + '|' + u; if (seen.has(k)) return; seen.add(k);
    out.push({url: u, kind, ...pos(el)});
  };
  const best = ss => { let bu = null, bw = -1;
    for (const part of String(ss).split(/,\\s+(?=\\S)/)) {
      const [u, d] = part.trim().split(/\\s+/); const w = parseFloat(d) || 1;
      if (u && w > bw) { bw = w; bu = u } }
    return bu };
  for (const img of document.querySelectorAll('img')) {
    add(img.currentSrc || img.src, 'img', img);
    for (const a of ['srcset', 'data-srcset']) { const v = img.getAttribute(a); if (v) add(best(v), 'img', img) }
    for (const a of ['data-src', 'data-lazy-src', 'data-original', 'data-lazy']) add(img.getAttribute(a), 'img', img);
  }
  for (const s of document.querySelectorAll('picture source')) {
    const v = s.getAttribute('srcset') || s.getAttribute('data-srcset');
    if (v) add(best(v), 'img', s.parentElement.querySelector('img') || s.parentElement);
  }
  for (const v of document.querySelectorAll('video')) {
    add(v.currentSrc || v.getAttribute('src') || v.getAttribute('data-src'), 'video', v);
    for (const s of v.querySelectorAll('source')) add(s.getAttribute('src') || s.getAttribute('data-src'), 'video', v);
    if (v.poster) add(v.poster, 'img', v);
  }
  if (withBg) for (const el of document.querySelectorAll('body *')) {
    for (const pseudo of [null, '::before', '::after']) {
      const bg = getComputedStyle(el, pseudo).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url('))
        for (const m of bg.matchAll(/url\\(["']?(.*?)["']?\\)/g)) add(m[1], 'img', el);
    }
  }
  for (const f of document.querySelectorAll('iframe')) add(f.src || f.getAttribute('data-src') || f.getAttribute('data-lazy-src') || f.getAttribute('data-original'), 'iframe', f);
  for (const el of document.querySelectorAll('[class*="wistia_async_"]')) {
    const m = el.className.match(/wistia_async_(\\w+)/);
    if (m) add('https://fast.wistia.net/embed/iframe/' + m[1], 'iframe', el);
  }
  for (const obj of document.querySelectorAll('object[data], embed[src]')) {
    const src = obj.getAttribute('data') || obj.getAttribute('src');
    if (src && /\\.svg(\\?|#|$)/i.test(src)) add(src, 'img', obj);
  }
  for (const svg of document.querySelectorAll('svg')) {
    const r = svg.getBoundingClientRect();
    if (r.width >= 20 && r.height >= 20) {
      const use = svg.querySelector('use');
      const href = use ? (use.getAttribute('href') || use.getAttribute('xlink:href')) : null;
      if (href && !href.startsWith('#')) {
        add(href, 'img', svg);
      } else {
        try {
          const s = new XMLSerializer().serializeToString(svg);
          if (s && s.length > 50 && s.length < 500000) {
            const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
            out.push({url: dataUrl, kind: 'img', ...pos(svg)});
          }
        } catch(e) {}
      }
    }
  }
  for (const a of document.querySelectorAll('a[href]')) {
    const h = a.href;
    if (/\\.(mp4|webm|mov|m4v|m3u8)(\\?|#|$)/i.test(h)) add(h, 'video', a);
    else if (/\\.gif(\\?|#|$)/i.test(h)) add(h, 'img', a);
    else if (/\\.svg(\\?|#|$)/i.test(h)) add(h, 'img', a);
    else if (/(youtube\\.com\\/(watch|shorts)|youtu\\.be\\/|vimeo\\.com\\/\\d|loom\\.com\\/share\\/|supademo\\.com|arcade\\.software|storylane\\.io|vidyard\\.com)/i.test(h)) add(h, 'iframe', a);
  }
  const scanShadowRoots = (root) => {
    try {
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        const sr = el.shadowRoot;
        try {
          for (const img of sr.querySelectorAll('img')) {
            add(img.currentSrc || img.src, 'img', img);
            for (const a of ['srcset','data-srcset']) { const v = img.getAttribute(a); if (v) add(best(v), 'img', img) }
            for (const a of ['data-src','data-lazy-src','data-original','data-lazy']) add(img.getAttribute(a), 'img', img);
          }
          for (const v of sr.querySelectorAll('video')) {
            add(v.currentSrc || v.getAttribute('src') || v.getAttribute('data-src'), 'video', v);
            for (const s of v.querySelectorAll('source')) add(s.getAttribute('src') || s.getAttribute('data-src'), 'video', v);
          }
          for (const f of sr.querySelectorAll('iframe')) {
            const src = f.src || f.getAttribute('data-src') || f.getAttribute('data-lazy-src');
            if (src) add(src, 'iframe', f);
          }
          for (const svg of sr.querySelectorAll('svg')) {
            const r = svg.getBoundingClientRect();
            if (r.width >= 20 && r.height >= 20) {
              try {
                const s = new XMLSerializer().serializeToString(svg);
                if (s && s.length > 50 && s.length < 500000) {
                  const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
                  out.push({url: dataUrl, kind: 'img', ...pos(svg)});
                }
              } catch(e) {}
            }
          }
          if (withBg) for (const el2 of sr.querySelectorAll('*')) {
            const bg = getComputedStyle(el2).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url('))
              for (const m of bg.matchAll(/url\\(["']?(.*?)["']?\\)/g)) add(m[1], 'img', el2);
          }
          scanShadowRoots(sr);
        } catch(e) {}
      }
    } catch(e) {}
  };
  scanShadowRoots(document);
  return out;
}`;

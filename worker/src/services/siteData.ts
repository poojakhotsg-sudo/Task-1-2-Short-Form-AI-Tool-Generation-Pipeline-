// grabber.py's SITE_DATA_JS, ported verbatim (not reinterpreted) —
// title, description, headings, feature text, video URLs, large image
// URLs, and where the hero section ends (used by saveHero()).
export const SITE_DATA_JS = `() => {
  const clean = t => (t || '').replace(/\\s+/g, ' ').trim();
  const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
  const ok = u => u && !u.startsWith('blob:') && !u.startsWith('data:');
  const uniq = a => [...new Set(a.filter(Boolean))];
  const meta = n => { const m = document.querySelector(\`meta[name="\${n}"], meta[property="\${n}"]\`);
    return m ? clean(m.content) : ''; };
  const heads = tag => uniq([...document.querySelectorAll(tag)].filter(vis).map(h => clean(h.innerText)))
    .filter(t => t.length > 1 && t.length < 200);

  const features = [];
  const seen = new Set();
  for (const h of document.querySelectorAll('h3, h4, [class*="feature" i] :is(h2, h3, strong)')) {
    if (!vis(h)) continue;
    const title = clean(h.innerText);
    if (!title || title.length > 120 || seen.has(title)) continue;
    let p = null, el = h;
    for (let i = 0; i < 4 && el && !p; i++) {
      let sib = el.nextElementSibling;
      while (sib && !p) { if (/^(P|DIV|SPAN)$/.test(sib.tagName) && clean(sib.innerText).length > 20) p = sib; sib = sib.nextElementSibling; }
      el = el.parentElement;
    }
    const text = p ? clean(p.innerText).slice(0, 300) : '';
    seen.add(title);
    features.push({title, text});
    if (features.length >= 40) break;
  }

  const videos = [];
  document.querySelectorAll('video').forEach(v => {
    [v.currentSrc, v.src, v.getAttribute('data-src')].forEach(u => ok(u) && videos.push(abs(u)));
    v.querySelectorAll('source').forEach(s => [s.src, s.getAttribute('data-src')].forEach(u => ok(u) && videos.push(abs(u))));
  });
  const embeds = [...document.querySelectorAll('iframe')].map(f => f.src)
    .filter(u => /youtube|vimeo|wistia|loom/.test(u || '')).map(u => u.split('?')[0]);

  const images = [];
  document.querySelectorAll('img').forEach(img => {
    const r = img.getBoundingClientRect(), u = img.currentSrc || img.src;
    if (!ok(u)) return;
    if (img.naturalWidth >= 600 || (r.width >= 400 && r.height >= 250))
      images.push({url: abs(u), width: img.naturalWidth, height: img.naturalHeight, alt: clean(img.alt).slice(0, 120)});
  });
  for (const el of document.querySelectorAll('body *')) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 400 || r.height < 250) continue;
    for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g))
      if (ok(m[1])) images.push({url: abs(m[1]), width: Math.round(r.width), height: Math.round(r.height),
                                alt: '', css_background: true});
  }
  let heroBottom = 0;
  const h1 = [...document.querySelectorAll('h1')].find(vis);
  if (h1) {
    let el = h1;
    while (el.parentElement && el.parentElement !== document.body && el.getBoundingClientRect().height < 500)
      el = el.parentElement;
    heroBottom = Math.round(el.getBoundingClientRect().bottom + scrollY);
  }
  const imgSeen = new Set();
  return {
    hero_bottom: heroBottom,
    title: clean(document.title), description: meta('description') || meta('og:description'),
    h1: heads('h1'), h2: heads('h2'), features,
    videos: uniq(videos), embeds: uniq(embeds),
    images: images.filter(i => !imgSeen.has(i.url) && imgSeen.add(i.url)).slice(0, 60),
  };
}`;

export interface SiteData {
  title: string;
  description: string;
  h1: string[];
  h2: string[];
  features: { title: string; text: string }[];
  videos: string[];
  embeds: string[];
  images: { url: string; width: number; height: number; alt: string; css_background?: boolean }[];
}

// What SITE_DATA_JS actually returns from the browser — hero_bottom is
// only used internally (by saveHero()) and stripped before the public
// SiteData shape is returned to callers.
export interface RawSiteData extends SiteData {
  hero_bottom: number;
}

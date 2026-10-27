import { setJobStatus, upsertStageStatus, saveJobAssets, type ExtractedAssetItem } from './jobState';

export async function runLocalExtraction(
  jobId: string,
  url: string,
  toolName: string,
  toolSlug: string,
  headed: boolean = false
): Promise<void> {
  const startedAt = new Date().toISOString();
  await setJobStatus(jobId, 'running', { started_at: startedAt });
  await upsertStageStatus(jobId, 'extract', {
    status: 'running',
    message: `Connecting to ${url}...`,
    started_at: startedAt,
  });

  try {
    const assets = await scrapePageMedia(url, headed);

    await saveJobAssets(jobId, assets);

    const counts = {
      videos: assets.filter(a => a.category === 'videos').length,
      gifs: assets.filter(a => a.category === 'gifs').length,
      images: assets.filter(a => a.category === 'images').length,
      svgs: assets.filter(a => a.category === 'svgs').length,
      embeds: assets.filter(a => a.category === 'embeds').length,
    };

    const summaryMsg = `Extracted ${assets.length} assets (${counts.videos} videos, ${counts.gifs} GIFs, ${counts.images} images, ${counts.svgs} SVGs, ${counts.embeds} embeds)`;

    const finishedAt = new Date().toISOString();
    await upsertStageStatus(jobId, 'extract', {
      status: 'done',
      message: summaryMsg,
      finished_at: finishedAt,
    });
    await setJobStatus(jobId, 'done', { finished_at: finishedAt });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Extraction failed for ${url}:`, errorMsg);
    const finishedAt = new Date().toISOString();
    await upsertStageStatus(jobId, 'extract', {
      status: 'failed',
      message: errorMsg,
      finished_at: finishedAt,
    });
    await setJobStatus(jobId, 'failed', { finished_at: finishedAt, error: errorMsg });
  }
}

async function scrapePageMedia(targetUrl: string, headed: boolean): Promise<ExtractedAssetItem[]> {
  const { chromium } = await import('playwright');

  let browser;
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      browser = await chromium.launch({
        channel,
        headless: !headed,
      });
      break;
    } catch {
      continue;
    }
  }

  if (!browser) {
    throw new Error('No compatible browser found to launch Playwright');
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Scroll to trigger lazy loading
    try {
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        await page.waitForTimeout(600);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch {
      // ignore scroll issues
    }

    const rawData = await page.evaluate(() => {
      const items: Array<{
        url: string;
        rawType: string;
        width?: number;
        height?: number;
        alt?: string;
      }> = [];

      // 1. Videos
      document.querySelectorAll('video, video source').forEach((el) => {
        const src = (el as HTMLVideoElement | HTMLSourceElement).src;
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
          items.push({ url: src, rawType: 'video' });
        }
      });

      // 2. Images & SVGs & GIFs
      document.querySelectorAll('img').forEach((el) => {
        const src = el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original');
        if (src && !src.startsWith('data:image/svg+xml;base64,PHN2')) {
          items.push({
            url: src,
            rawType: 'img',
            width: el.naturalWidth || el.width,
            height: el.naturalHeight || el.height,
            alt: el.alt,
          });
        }
      });

      // 3. Background Images
      document.querySelectorAll('*').forEach((el) => {
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && bg.startsWith('url(')) {
          const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
          if (match && match[1] && match[1].startsWith('http')) {
            items.push({ url: match[1], rawType: 'bg' });
          }
        }
      });

      // 4. Embeds & IFrames
      document.querySelectorAll('iframe').forEach((el) => {
        const src = el.src;
        if (src && src.startsWith('http')) {
          items.push({ url: src, rawType: 'iframe' });
        }
      });

      return items;
    });

    const seenUrls = new Set<string>();
    const assets: ExtractedAssetItem[] = [];

    let order = 0;
    for (const item of rawData) {
      if (!item.url || seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      const urlLower = item.url.toLowerCase();

      // Categorize
      let category: 'videos' | 'gifs' | 'images' | 'svgs' | 'embeds' = 'images';

      if (
        item.rawType === 'video' ||
        urlLower.endsWith('.mp4') ||
        urlLower.endsWith('.webm') ||
        urlLower.endsWith('.mov') ||
        urlLower.endsWith('.m3u8')
      ) {
        category = 'videos';
      } else if (urlLower.endsWith('.gif') || urlLower.includes('.gif?')) {
        category = 'gifs';
      } else if (
        urlLower.endsWith('.svg') ||
        urlLower.includes('.svg?') ||
        item.url.startsWith('data:image/svg')
      ) {
        category = 'svgs';
      } else if (
        item.rawType === 'iframe' ||
        urlLower.includes('youtube.com') ||
        urlLower.includes('vimeo.com') ||
        urlLower.includes('loom.com') ||
        urlLower.includes('embed')
      ) {
        category = 'embeds';
      } else {
        category = 'images';
      }

      // Filter tracking / 1x1 pixels
      if (item.width && item.height && item.width <= 2 && item.height <= 2) {
        continue;
      }

      let filename = 'asset';
      try {
        const u = new URL(item.url);
        const parts = u.pathname.split('/').filter(Boolean);
        filename = parts[parts.length - 1] || 'asset';
        if (filename.length > 50) filename = filename.substring(0, 45) + '...';
      } catch {
        filename = `${category}_${order}`;
      }

      assets.push({
        filename,
        category,
        storageKey: item.url,
        url: item.url,
        sourceUrl: item.url,
        width: item.width || null,
        height: item.height || null,
        sizeBytes: 0,
        pageOrder: order++,
        section: item.alt || '',
      });
    }

    return assets;
  } finally {
    await browser.close();
  }
}

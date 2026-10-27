'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type AssetCategory = 'all' | 'videos' | 'gifs' | 'images' | 'svgs' | 'embeds';
type SortMode = 'page_order' | 'largest' | 'newest';

interface AssetItem {
  filename: string;
  category: string;
  storageKey: string;
  url: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  sizeBytes: number;
  pageOrder: number;
  section?: string;
}

interface ExtractJobResponse {
  jobId: string;
  toolSlug: string;
  status: string;
}

interface JobStatusResponse {
  job: {
    id: string;
    tool_slug: string;
    tool_name: string;
    url: string;
    status: string;
    created_at: string;
    updated_at: string;
    error?: string;
  };
  stages: { stage: string; status: string; message?: string }[];
  assets?: AssetItem[];
}

function fmtBytes(b: number) {
  if (!b || b === 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDur(s?: number | null) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function isTerminal(s: string) {
  return ['done', 'failed', 'stopped', 'interrupted'].includes(s);
}

export default function ExtractorClient() {
  const [rawUrls, setRawUrls]         = useState('https://www.canva.com');
  const [toolName, setToolName]       = useState('canva');
  const [headed, setHeaded]           = useState(false);
  const [jobId, setJobId]             = useState<string | null>(null);
  const [jobStatus, setJobStatus]     = useState<JobStatusResponse | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');
  const [assets, setAssets]           = useState<AssetItem[]>([]);
  const [category, setCategory]       = useState<AssetCategory>('all');
  const [sort, setSort]               = useState<SortMode>('page_order');
  const [search, setSearch]           = useState('');
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [ticker, setTicker]           = useState(0);

  const fetchStatus = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) return;
      const data: JobStatusResponse = await res.json();
      setJobStatus(data);
      if (data.assets && data.assets.length > 0) {
        setAssets(data.assets);
      }
      if (isTerminal(data.job.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch {
      // ignore polling errors
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    fetchStatus(jobId);
    pollRef.current = setInterval(() => setTicker(t => t + 1), 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, fetchStatus]);

  useEffect(() => {
    if (jobId && jobStatus && !isTerminal(jobStatus.job.status)) fetchStatus(jobId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  async function handleExtract(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const urlList = rawUrls.split(/[\s,]+/).map(u => u.trim()).filter(Boolean);
    if (urlList.length === 0) { setError('Enter at least one URL.'); return; }
    const url = urlList[0];
    const name = toolName.trim() || new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    setSubmitting(true);
    setAssets([]);
    setSelected(new Set());
    try {
      const res = await fetch('/api/extract-assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: name, url: url.startsWith('http') ? url : `https://${url}`, headed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setError(data?.error ?? `Request failed (HTTP ${res.status})`);
        return;
      }
      setJobStatus(null);
      setJobId(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSubmitting(false);
    }
  }

  /* derived asset list */
  const filtered = assets
    .filter(a => {
      if (category !== 'all') {
        if (category === 'videos' && a.category !== 'videos' && a.category !== 'videos_gifs') return false;
        if (category !== 'videos' && a.category !== category) return false;
      }
      if (search && !a.filename.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === 'page_order') return a.pageOrder - b.pageOrder;
      if (sort === 'largest')   return b.sizeBytes - a.sizeBytes;
      return 0;
    });

  const categoryCounts = {
    all: assets.length,
    videos: assets.filter(a => a.category === 'videos' || a.category === 'videos_gifs').length,
    gifs: assets.filter(a => a.category === 'gifs').length,
    images: assets.filter(a => a.category === 'images').length,
    svgs: assets.filter(a => a.category === 'svgs').length,
    embeds: assets.filter(a => a.category === 'embeds').length,
  };

  const runStatus = jobStatus?.job;
  const running   = runStatus && !isTerminal(runStatus.status);

  function toggleSelect(key: string) {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="page-wrap" style={{ paddingTop: 32, paddingBottom: 64 }}>

      <div className="page-header">
        <h1 className="page-header__title">Standalone Extractor</h1>
        <p className="page-header__sub">Extract media from any AI tool website — videos, GIFs, images, SVGs, and embeds.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 24, alignItems: 'start' }}>

        {/* ── form ─── */}
        <div>
          <form id="extractor-form" onSubmit={handleExtract}>
            <div className="card">
              <div className="card__header">
                <span style={{ fontSize: 16 }}>🔗</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Extract Assets</span>
              </div>
              <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <label className="field__label" htmlFor="extract-urls">Website URL</label>
                  <textarea
                    id="extract-urls"
                    className="field__textarea"
                    placeholder="https://www.canva.com"
                    value={rawUrls}
                    onChange={e => setRawUrls(e.target.value)}
                    rows={3}
                  />
                  <span className="field__hint">Target website to scrape</span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="extract-name">Tool name (optional)</label>
                  <input
                    id="extract-name"
                    className="field__input"
                    placeholder="canva"
                    value={toolName}
                    onChange={e => setToolName(e.target.value)}
                  />
                </div>

                <label className="toggle">
                  <input type="checkbox" checked={headed} onChange={e => setHeaded(e.target.checked)} id="extract-headed" />
                  Show browser window
                </label>

                {error && <p className="field__error">⚠ {error}</p>}
              </div>
              <div className="card__footer" style={{ display: 'flex', gap: 8 }}>
                <button
                  id="extract-btn"
                  type="submit"
                  className="btn btn--primary"
                  disabled={submitting || !!running}
                  style={{ flex: 1 }}
                >
                  {submitting ? '⏳ Starting…' : '⬇ Extract'}
                </button>
              </div>
            </div>
          </form>

          {/* job status card */}
          {runStatus && (
            <div className="card mt-3">
              <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="flex items-center gap-2">
                  <span className={`status-dot status-dot--${runStatus.status}`} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{runStatus.tool_name}</span>
                  <span className={`badge badge--${runStatus.status === 'done' ? 'green' : runStatus.status === 'failed' ? 'red' : 'yellow'}`}>{runStatus.status}</span>
                </div>
                {running && (
                  <div className="progress">
                    <div className="progress__fill progress__fill--indeterminate" />
                  </div>
                )}
                {jobStatus?.stages.map(s => (
                  <div key={s.stage} className="text-sm" style={{ color: s.status === 'done' ? 'var(--green)' : s.status === 'failed' ? 'var(--red)' : 'var(--text-muted)' }}>
                    {s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '⋯'} {s.message || s.stage}
                  </div>
                ))}
                {runStatus.error && <p className="text-sm" style={{ color: 'var(--red)' }}>{runStatus.error}</p>}
              </div>
            </div>
          )}
        </div>

        {/* ── results ─── */}
        <div>
          {assets.length === 0 && !running ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-state__icon">🖼️</div>
                <div className="empty-state__title">No assets extracted yet</div>
                <div className="empty-state__sub">Click &quot;Extract&quot; on the left to capture all videos, GIFs, images, SVGs, and embeds.</div>
              </div>
            </div>
          ) : (
            <>
              {/* Category tabs */}
              <div className="tabs" style={{ overflowX: 'auto', display: 'flex', flexWrap: 'nowrap', gap: 6 }}>
                {(['all', 'videos', 'gifs', 'images', 'svgs', 'embeds'] as const).map(catKey => {
                  const labelMap: Record<string, string> = {
                    all: 'All',
                    videos: 'Videos',
                    gifs: 'GIFs',
                    images: 'Images',
                    svgs: 'SVGs',
                    embeds: 'Embeds',
                  };
                  return (
                    <button
                      key={catKey}
                      id={`cat-${catKey}`}
                      className={`tab${category === catKey ? ' tab--active' : ''}`}
                      onClick={() => setCategory(catKey)}
                    >
                      {labelMap[catKey]}
                      <span className="tab__count">{categoryCounts[catKey]}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
                <input
                  id="asset-search"
                  className="field__input"
                  placeholder="Filter by filename…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ width: 220 }}
                />
                <select
                  id="asset-sort"
                  className="field__select"
                  value={sort}
                  onChange={e => setSort(e.target.value as SortMode)}
                  style={{ width: 160 }}
                >
                  <option value="page_order">Page order</option>
                  <option value="largest">Largest first</option>
                </select>
                <div style={{ flex: 1 }} />
                {selected.size > 0 && (
                  <button id="download-selected" className="btn btn--secondary btn--sm">
                    ⬇ {selected.size} selected
                  </button>
                )}
                {assets.length > 0 && (
                  <button
                    id="select-all"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setSelected(new Set(filtered.map(a => a.storageKey)))}
                  >
                    Select all
                  </button>
                )}
              </div>

              {filtered.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state__icon">🔍</div>
                  <div className="empty-state__title">No {category} found</div>
                </div>
              ) : (
                <div className="media-grid">
                  {filtered.map(asset => (
                    <div
                      key={asset.storageKey}
                      className={`media-card${selected.has(asset.storageKey) ? ' media-card--selected' : ''}`}
                      id={`asset-${asset.filename.replace(/[^a-zA-Z0-9]/g, '-')}`}
                      onClick={() => toggleSelect(asset.storageKey)}
                      style={{ aspectRatio: (asset.width && asset.height && asset.width > 0 && asset.height > 0) ? `${asset.width}/${asset.height}` : '16/9' }}
                    >
                      {asset.category === 'videos' || asset.category === 'videos_gifs' ? (
                        <video
                          src={asset.url}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          muted
                          loop
                          playsInline
                          onMouseEnter={e => e.currentTarget.play().catch(() => {})}
                          onMouseLeave={e => e.currentTarget.pause()}
                        />
                      ) : asset.category === 'embeds' ? (
                        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-3)', padding: 12, textAlign: 'center' }}>
                          <span style={{ fontSize: 32, marginBottom: 8 }}>📺</span>
                          <span className="truncate" style={{ fontSize: 12, color: 'var(--text-muted)' }}>{asset.filename}</span>
                        </div>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={asset.url}
                          alt={asset.filename}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      )}
                      <div className="media-card__overlay" />
                      <div className="media-card__info">
                        <div className="truncate" style={{ fontWeight: 600, marginBottom: 2 }}>{asset.filename}</div>
                        <div>
                          <span className="badge badge--sm" style={{ marginRight: 6 }}>{asset.category}</span>
                          {fmtBytes(asset.sizeBytes)}
                          {asset.durationSeconds ? ` · ${fmtDur(asset.durationSeconds)}` : ''}
                        </div>
                        {asset.width && asset.height && <div>{asset.width}×{asset.height}</div>}
                      </div>
                      <div className="media-card__check">✓</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

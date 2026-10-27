'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type AssetCategory = 'videos_gifs' | 'images' | 'all';
type SortMode = 'page_order' | 'largest' | 'newest';

interface AssetItem {
  filename: string;
  category: AssetCategory;
  storageKey: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  sizeBytes: number;
  pageOrder: number;
  section: string;
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
}

function fmtBytes(b: number) {
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
  const [rawUrls, setRawUrls]         = useState('');
  const [toolName, setToolName]       = useState('');
  const [headed, setHeaded]           = useState(false);
  const [jobId, setJobId]             = useState<string | null>(null);
  const [jobStatus, setJobStatus]     = useState<JobStatusResponse | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');
  const [assets, setAssets]           = useState<AssetItem[]>([]);
  const [category, setCategory]       = useState<AssetCategory | 'all'>('all');
  const [sort, setSort]               = useState<SortMode>('page_order');
  const [search, setSearch]           = useState('');
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [ticker, setTicker]           = useState(0);

  const fetchStatus = useCallback(async (id: string) => {
    const res = await fetch(`/api/jobs/${id}`);
    if (!res.ok) return;
    const data: JobStatusResponse = await res.json();
    setJobStatus(data);
    if (isTerminal(data.job.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      // TODO: load assets from the extract result once asset listing endpoint exists
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
    const url = urlList[0]; // single-tool extraction (EXTRACT-10)
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
      if (category !== 'all' && a.category !== category) return false;
      if (search && !a.filename.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sort === 'page_order') return a.pageOrder - b.pageOrder;
      if (sort === 'largest')   return b.sizeBytes - a.sizeBytes;
      return 0;
    });

  const videos = assets.filter(a => a.category === 'videos_gifs');
  const images = assets.filter(a => a.category === 'images');

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
        <p className="page-header__sub">Extract media from any AI tool website — videos, GIFs, images, and embeds.</p>
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
                    placeholder="https://gamma.app"
                    value={rawUrls}
                    onChange={e => setRawUrls(e.target.value)}
                    rows={3}
                  />
                  <span className="field__hint">One URL (multi-URL batch coming in Phase 2)</span>
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="extract-name">Tool name (optional)</label>
                  <input
                    id="extract-name"
                    className="field__input"
                    placeholder="Auto-detected from domain"
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
                    {s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : '⋯'} {s.stage}: {s.message ?? s.status}
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
                <div className="empty-state__title">No assets yet</div>
                <div className="empty-state__sub">Run an extraction to see videos, GIFs, and images here.</div>
              </div>
            </div>
          ) : (
            <>
              {/* tabs + controls */}
              <div className="tabs">
                {([['all','All'], ['videos_gifs','Videos & GIFs'], ['images','Images']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    id={`cat-${val}`}
                    className={`tab${category === val ? ' tab--active' : ''}`}
                    onClick={() => setCategory(val as AssetCategory | 'all')}
                  >
                    {label}
                    <span className="tab__count">
                      {val === 'all' ? assets.length : val === 'videos_gifs' ? videos.length : images.length}
                    </span>
                  </button>
                ))}
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
                    ⬇ Download {selected.size} selected
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
                  <div className="empty-state__title">No {category === 'all' ? 'assets' : category.replace('_', ' & ')} found</div>
                </div>
              ) : (
                <div className="media-grid">
                  {filtered.map(asset => (
                    <div
                      key={asset.storageKey}
                      className={`media-card${selected.has(asset.storageKey) ? ' media-card--selected' : ''}`}
                      id={`asset-${asset.filename.replace(/\./g, '-')}`}
                      onClick={() => toggleSelect(asset.storageKey)}
                      style={{ aspectRatio: (asset.width && asset.height) ? `${asset.width}/${asset.height}` : '9/16' }}
                    >
                      {asset.category === 'videos_gifs' ? (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-3)', fontSize: 32 }}>🎬</div>
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-3)', fontSize: 32 }}>🖼️</div>
                      )}
                      <div className="media-card__overlay" />
                      <div className="media-card__info">
                        <div className="truncate" style={{ fontWeight: 600, marginBottom: 2 }}>{asset.filename}</div>
                        <div>{fmtBytes(asset.sizeBytes)}{asset.durationSeconds ? ` · ${fmtDur(asset.durationSeconds)}` : ''}</div>
                        {asset.width && <div>{asset.width}×{asset.height}</div>}
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

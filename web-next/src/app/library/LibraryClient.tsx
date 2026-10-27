'use client';

import { useState, useEffect } from 'react';
import type { Tool, KeywordRecord } from '@/types/domain';

type ActiveTab = 'tools' | 'keywords';
type Filter = 'all' | 'free' | 'paid';

interface LibraryResponse { tools: Tool[]; }
interface KeywordsResponse { keywords: KeywordRecord[]; }

export default function LibraryClient() {
  const [tab, setTab]           = useState<ActiveTab>('tools');
  const [filter, setFilter]     = useState<Filter>('all');
  const [search, setSearch]     = useState('');
  const [tools, setTools]       = useState<Tool[]>([]);
  const [keywords, setKeywords] = useState<KeywordRecord[]>([]);
  const [loading, setLoading]   = useState(true);
  const [copied, setCopied]     = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [tRes, kRes] = await Promise.all([
          fetch('/api/library'),
          fetch('/api/keywords'),
        ]);
        if (tRes.ok) { const d: LibraryResponse = await tRes.json(); setTools(d.tools ?? []); }
        if (kRes.ok) { const d: KeywordsResponse = await kRes.json(); setKeywords(d.keywords ?? []); }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  /* persist tab + tier in localStorage (UI-04) */
  useEffect(() => {
    const savedTab = localStorage.getItem('library.tab') as ActiveTab | null;
    const savedFilter = localStorage.getItem('library.filter') as Filter | null;
    if (savedTab) setTab(savedTab);
    if (savedFilter) setFilter(savedFilter);
  }, []);
  useEffect(() => { localStorage.setItem('library.tab', tab); }, [tab]);
  useEffect(() => { localStorage.setItem('library.filter', filter); }, [filter]);

  /* filter tools */
  const filteredTools = tools.filter(t => {
    if (filter !== 'all' && t.priceTier !== filter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      t.name.toLowerCase().includes(q) ||
      t.url.toLowerCase().includes(q) ||
      (t.commentKeyword ?? '').toLowerCase().includes(q)
    );
  });

  /* filter keywords */
  const filteredKeywords = keywords.filter(k => {
    if (!search) return true;
    const q = search.toLowerCase();
    return k.keyword.toLowerCase().includes(q) || k.toolName.toLowerCase().includes(q);
  });

  async function copyGoLink(keyword: string) {
    const base = window.location.origin;
    await navigator.clipboard.writeText(`${base}/go/${keyword}`);
    setCopied(keyword);
    setTimeout(() => setCopied(null), 1800);
  }

  return (
    <div className="page-wrap" style={{ paddingTop: 32, paddingBottom: 64 }}>

      {/* ── header ─── */}
      <div className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-header__title">Asset Library</h1>
            <p className="page-header__sub">All processed tools with Reel Kits, hooks, lead magnets, and keyword links.</p>
          </div>
          <a href="/" className="btn btn--primary" id="library-new-run">＋ New Run</a>
        </div>

        {/* search */}
        <div style={{ marginTop: 20 }}>
          <input
            id="library-search"
            className="field__input"
            placeholder="Search tools, hooks, keywords…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: 400 }}
          />
        </div>
      </div>

      {/* ── tabs ─── */}
      <div className="tabs">
        <button
          id="tab-tools"
          className={`tab${tab === 'tools' ? ' tab--active' : ''}`}
          onClick={() => setTab('tools')}
        >
          Tools <span className="tab__count">{tools.length}</span>
        </button>
        <button
          id="tab-keywords"
          className={`tab${tab === 'keywords' ? ' tab--active' : ''}`}
          onClick={() => setTab('keywords')}
        >
          Keywords <span className="tab__count">{keywords.length}</span>
        </button>
      </div>

      {/* ── tools tab ─── */}
      {tab === 'tools' && (
        <>
          {/* filter bar */}
          <div className="flex items-center gap-2 mb-4">
            {(['all', 'free', 'paid'] as Filter[]).map(f => (
              <button
                key={f}
                id={`filter-${f}`}
                className={`btn btn--sm ${filter === f ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setFilter(f)}
                style={{ textTransform: 'capitalize' }}
              >
                {f}
              </button>
            ))}
            <span className="text-sm text-muted" style={{ marginLeft: 8 }}>
              {filteredTools.length} tool{filteredTools.length !== 1 ? 's' : ''}
            </span>
          </div>

          {loading ? (
            <div className="grid-4">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="card" style={{ height: 280 }}>
                  <div className="skeleton" style={{ height: '50%', borderRadius: 0 }} />
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div className="skeleton" style={{ height: 14, width: '60%' }} />
                    <div className="skeleton" style={{ height: 12, width: '40%' }} />
                    <div className="skeleton" style={{ height: 12, width: '80%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredTools.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state__icon">{search ? '🔍' : '📦'}</div>
              <div className="empty-state__title">{search ? 'No matching tools' : 'No tools yet'}</div>
              <div className="empty-state__sub">
                {search ? 'Try a different search term.' : 'Run the pipeline for an AI tool to see it here.'}
              </div>
              {!search && <a href="/" className="btn btn--primary mt-3" id="empty-new-run">＋ Run Pipeline</a>}
            </div>
          ) : (
            <div className="grid-4">
              {filteredTools.map(tool => (
                <ToolCard key={tool.slug} tool={tool} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── keywords tab ─── */}
      {tab === 'keywords' && (
        <>
          {loading ? (
            <div className="empty-state"><div className="skeleton" style={{ width: 200, height: 20 }} /></div>
          ) : filteredKeywords.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state__icon">🔑</div>
              <div className="empty-state__title">No keywords configured</div>
              <div className="empty-state__sub">Add a comment keyword when extracting a tool.</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table id="keywords-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-soft)' }}>
                    {['Keyword', 'Tool', '/go link', 'Destination', 'Clicks', 'Status'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredKeywords.map(k => (
                    <tr key={k.keyword} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <td style={{ padding: '12px 14px' }}>
                        <code className="mono">{k.keyword}</code>
                        {k.duplicate && <span className="badge badge--yellow" style={{ marginLeft: 6 }}>Duplicate</span>}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13 }}>{k.toolName}</td>
                      <td style={{ padding: '12px 14px' }}>
                        <div className="flex items-center gap-2">
                          <a
                            href={`/go/${k.keyword}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm"
                            style={{ color: 'var(--accent-2)' }}
                          >
                            /go/{k.keyword}
                          </a>
                          <button
                            className="btn btn--ghost btn--sm btn--icon"
                            onClick={() => copyGoLink(k.keyword)}
                            data-tooltip={copied === k.keyword ? 'Copied!' : 'Copy link'}
                            id={`copy-${k.keyword}`}
                          >
                            {copied === k.keyword ? '✓' : '⎘'}
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-muted)', maxWidth: 200 }} className="truncate">
                        {k.destination}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{k.clickCount}</td>
                      <td style={{ padding: '12px 14px' }}>
                        {k.duplicate
                          ? <span className="badge badge--yellow">⚠ Duplicate</span>
                          : <span className="badge badge--green">✓ Active</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── ToolCard ────────────────────────────────────────────────── */
function ToolCard({ tool }: { tool: Tool }) {
  return (
    <div className="tool-card" id={`tool-${tool.slug}`}>
      <div className="tool-card__thumb-placeholder">🤖</div>
      <div className="tool-card__body">
        <div className="tool-card__name">{tool.name}</div>
        <div className="tool-card__url">{tool.url}</div>
        {tool.hasReelKit && (
          <p className="tool-card__hook">
            "Hook content available"
          </p>
        )}
      </div>
      <div className="tool-card__footer">
        <span className={`badge badge--${tool.priceTier === 'free' ? 'green' : 'purple'}`}>
          {tool.priceTier === 'free' ? '🆓 Free' : '💎 Paid'}
        </span>
        {tool.hasReelKit && <span className="badge badge--blue">🎬 Reel Kit</span>}
        <div style={{ flex: 1 }} />
        <a
          href={`/?tool=${tool.slug}`}
          className="btn btn--ghost btn--sm"
          id={`tool-run-${tool.slug}`}
        >
          Run
        </a>
      </div>
    </div>
  );
}

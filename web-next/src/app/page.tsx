'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

/* ─── types ───────────────────────────────────────────────────── */
type JobStatus = 'queued' | 'running' | 'stopping' | 'stopped' | 'done' | 'failed' | 'interrupted' | 'skipped';
type StageName = 'grab' | 'describe' | 'script' | 'match' | 'qa' | 'trial' | 'assemble' | 'upload';

interface StageRow {
  stage: StageName;
  status: JobStatus;
  message?: string;
  skipped_reason?: string;
  started_at?: string;
  finished_at?: string;
}

interface JobRow {
  id: string;
  tool_slug: string;
  tool_name: string;
  url: string;
  status: JobStatus;
  job_type: 'run' | 'extract';
  requested_stages: string[];
  created_at: string;
  updated_at: string;
  error?: string;
}

interface JobResponse { job: JobRow; stages: StageRow[]; }

const STAGE_ORDER: StageName[] = ['grab','describe','script','match','qa','trial','assemble','upload'];

const STAGE_LABELS: Record<StageName, string> = {
  grab: '📹 Grab', describe: '🔍 Describe', script: '✍️ Script',
  match: '🎯 Match', qa: '✅ QA', trial: '🎭 Trial',
  assemble: '🎬 Assemble', upload: '☁️ Upload',
};

/* ─── helpers ─────────────────────────────────────────────────── */
function statusColor(s?: JobStatus) {
  switch (s) {
    case 'running':  return 'green';
    case 'done':     return 'purple';
    case 'failed':   return 'red';
    case 'skipped':  return 'gray';
    case 'stopping': return 'yellow';
    default:         return 'gray';
  }
}

function elapsed(from?: string, to?: string) {
  if (!from) return '';
  const ms = (to ? new Date(to) : new Date()).getTime() - new Date(from).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function isTerminal(s?: JobStatus) {
  return s === 'done' || s === 'failed' || s === 'stopped' || s === 'interrupted';
}

/* ─── PipelinePage ─────────────────────────────────────────────── */
export default function PipelinePage() {
  const [toolName, setToolName]   = useState('');
  const [url, setUrl]             = useState('');
  const [headed, setHeaded]       = useState(false);
  const [stages, setStages]       = useState<StageName[]>([...STAGE_ORDER.slice(0, 7)]);
  const [jobId,  setJobId]        = useState<string | null>(null);
  const [job,    setJob]          = useState<JobRow | null>(null);
  const [stageMap, setStageMap]   = useState<Map<StageName, StageRow>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]         = useState('');
  const [ticker, setTicker]       = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* poll job status */
  const fetchJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok) return;
      const data: JobResponse = await res.json();
      setJob(data.job);
      const m = new Map<StageName, StageRow>();
      for (const s of data.stages) m.set(s.stage as StageName, s);
      setStageMap(m);
      if (isTerminal(data.job.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch { /* ignore transient errors */ }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    fetchJob(jobId);
    pollRef.current = setInterval(() => {
      setTicker(t => t + 1);
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, fetchJob]);

  useEffect(() => {
    if (jobId && !isTerminal(job?.status)) fetchJob(jobId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  /* submit */
  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!toolName.trim() || !url.trim()) { setError('Tool name and URL are required.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName, url, stages, headed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setError(data?.error ?? `Request failed (HTTP ${res.status})`);
        return;
      }
      setJob(null);
      setStageMap(new Map());
      setJobId(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error — check console.');
    } finally {
      setSubmitting(false);
    }
  }

  /* stop */
  async function handleStop() {
    if (!jobId) return;
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    fetchJob(jobId);
  }

  /* toggle stage */
  function toggleStage(s: StageName) {
    setStages(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    );
  }

  /* derive progress */
  const doneCount = [...stageMap.values()].filter(s => s.status === 'done').length;
  const reqCount  = stages.filter(s => STAGE_ORDER.includes(s)).length;
  const pct = reqCount > 0 ? Math.round((doneCount / reqCount) * 100) : 0;
  const running = job?.status === 'running' || job?.status === 'queued';

  return (
    <div className="page-wrap" style={{ paddingTop: 32, paddingBottom: 64 }}>

      {/* ── header ─── */}
      <div className="page-header">
        <h1 className="page-header__title">Run Pipeline</h1>
        <p className="page-header__sub">Extract assets and produce a 30–45 s Reel for any AI tool's public website.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 24, alignItems: 'start' }}>

        {/* ── form ─── */}
        <div>
          <form id="pipeline-form" onSubmit={handleRun} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div className="card">
              <div className="card__header">
                <span style={{ fontSize: 16 }}>🛠️</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>New Run</span>
              </div>
              <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                <div className="field">
                  <label className="field__label" htmlFor="tool-name">Tool name</label>
                  <input
                    id="tool-name"
                    className="field__input"
                    placeholder="e.g. Gamma"
                    value={toolName}
                    onChange={e => setToolName(e.target.value)}
                    autoComplete="off"
                  />
                </div>

                <div className="field">
                  <label className="field__label" htmlFor="tool-url">Website URL</label>
                  <input
                    id="tool-url"
                    className="field__input"
                    placeholder="https://gamma.app"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    type="url"
                  />
                </div>

                <div>
                  <p className="field__label" style={{ marginBottom: 10 }}>Stages</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {STAGE_ORDER.map(s => (
                      <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: stages.includes(s) ? 'var(--text)' : 'var(--text-dim)', userSelect: 'none' }}>
                        <input
                          type="checkbox"
                          checked={stages.includes(s)}
                          onChange={() => toggleStage(s)}
                          style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
                        />
                        {STAGE_LABELS[s]}
                      </label>
                    ))}
                  </div>
                </div>

                <label className="toggle">
                  <input type="checkbox" checked={headed} onChange={e => setHeaded(e.target.checked)} id="headed-toggle" />
                  Show browser window
                </label>

                {error && <p className="field__error">⚠ {error}</p>}
              </div>

              <div className="card__footer" style={{ display: 'flex', gap: 8 }}>
                <button
                  id="run-btn"
                  type="submit"
                  className="btn btn--primary btn--lg"
                  disabled={submitting || running}
                  style={{ flex: 1 }}
                >
                  {submitting ? '⏳ Starting…' : '▶ Run Pipeline'}
                </button>
                {running && (
                  <button
                    id="stop-btn"
                    type="button"
                    className="btn btn--danger"
                    onClick={handleStop}
                  >
                    ■ Stop
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>

        {/* ── job panel ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!job && (
            <div className="card">
              <div className="empty-state">
                <div className="empty-state__icon">🎬</div>
                <div className="empty-state__title">No active job</div>
                <div className="empty-state__sub">Fill in the form and click Run Pipeline to start.</div>
              </div>
            </div>
          )}

          {job && (
            <>
              {/* status card */}
              <div className="card">
                <div className="card__header" style={{ justifyContent: 'space-between' }}>
                  <div className="flex items-center gap-2">
                    <span className={`status-dot status-dot--${job.status}`} />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{job.tool_name}</span>
                    <span className={`badge badge--${statusColor(job.status)}`}>{job.status}</span>
                  </div>
                  <span className="text-sm text-muted font-semibold" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                    {elapsed(job.created_at, isTerminal(job.status) ? job.updated_at : undefined)}
                  </span>
                </div>

                <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <a href={job.url} target="_blank" rel="noopener noreferrer" className="text-sm" style={{ color: 'var(--accent-2)' }}>
                    {job.url} ↗
                  </a>

                  {/* progress bar */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-muted">{doneCount}/{reqCount} stages complete</span>
                      <span className="text-sm text-muted">{pct}%</span>
                    </div>
                    <div className="progress">
                      <div
                        className={`progress__fill${running && doneCount === 0 ? ' progress__fill--indeterminate' : ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>

                  {/* stage nodes */}
                  <div className="pipeline-stages">
                    {STAGE_ORDER.filter(s => stages.includes(s)).map((s, i) => {
                      const sr = stageMap.get(s);
                      const st = sr?.status ?? 'queued';
                      return (
                        <div key={s} className="stage-step">
                          {i > 0 && <div className="stage-step__connector" />}
                          <div
                            id={`stage-${s}`}
                            className={`stage-step__node stage-step__node--${st}`}
                            data-tooltip={sr?.message ?? st}
                          >
                            <span className="status-dot" style={{ width: 6, height: 6, background: st === 'done' ? 'var(--green)' : st === 'failed' ? 'var(--red)' : st === 'running' ? 'var(--green)' : 'var(--text-dim)' }} />
                            {STAGE_LABELS[s].split(' ')[1]}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* per-stage details */}
              <div className="card">
                <div className="card__header">
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Stage Details</span>
                </div>
                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {STAGE_ORDER.filter(s => stages.includes(s)).map(s => {
                    const sr = stageMap.get(s);
                    const st = sr?.status ?? 'queued';
                    return (
                      <div key={s} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-md)', background: 'var(--bg-2)' }}>
                        <span style={{ fontSize: 16 }}>{STAGE_LABELS[s].split(' ')[0]}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="flex items-center gap-2">
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{s}</span>
                            <span className={`badge badge--${statusColor(st)}`}>{st}</span>
                            {sr?.started_at && (
                              <span className="text-sm text-dim">
                                {elapsed(sr.started_at, sr.finished_at)}
                              </span>
                            )}
                          </div>
                          {sr?.message && <p className="text-sm text-muted" style={{ marginTop: 2 }}>{sr.message}</p>}
                          {sr?.skipped_reason && <p className="text-sm" style={{ marginTop: 2, color: 'var(--yellow)' }}>↳ {sr.skipped_reason}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* error */}
              {job.error && (
                <div className="card" style={{ borderColor: 'rgba(248,113,113,0.3)' }}>
                  <div className="card__body">
                    <p className="text-sm" style={{ color: 'var(--red)' }}>
                      <strong>Error:</strong> {job.error}
                    </p>
                  </div>
                </div>
              )}

              {/* download */}
              {job.status === 'done' && (
                <div className="card">
                  <div className="card__body" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <a
                      id="download-zip"
                      className="btn btn--secondary"
                      href={`/api/tools/${job.tool_slug}/zip`}
                    >
                      ⬇ Download ZIP
                    </a>
                    <a
                      id="view-library"
                      className="btn btn--ghost"
                      href="/library"
                    >
                      📚 View in Library
                    </a>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

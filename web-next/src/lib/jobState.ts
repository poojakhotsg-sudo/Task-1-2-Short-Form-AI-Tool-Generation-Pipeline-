import { getSupabaseServerClient, isSupabaseConfigured } from './supabase';

// In-memory fallback stores for local development without Supabase credentials
export interface StoredJob {
  id: string;
  tool_slug: string | null;
  tool_name: string;
  url: string;
  job_type: string;
  status: string;
  requested_stages: string[];
  headed: boolean;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
}

export interface StoredStage {
  job_id: string;
  stage: string;
  status: string;
  message?: string | null;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
}

const memoryJobs = new Map<string, StoredJob>();
const memoryStages = new Map<string, Map<string, StoredStage>>();

export interface NewJob {
  id: string;
  toolSlug: string | null;
  toolName: string;
  url: string;
  jobType: 'run' | 'extract';
  requestedStages: string[];
  headed?: boolean;
}

export async function createJob(job: NewJob): Promise<void> {
  const now = new Date().toISOString();

  if (!isSupabaseConfigured()) {
    memoryJobs.set(job.id, {
      id: job.id,
      tool_slug: job.toolSlug,
      tool_name: job.toolName,
      url: job.url,
      job_type: job.jobType,
      status: 'queued',
      requested_stages: job.requestedStages,
      headed: job.headed ?? false,
      created_at: now,
      updated_at: now,
    });
    return;
  }

  const supabase = getSupabaseServerClient();

  let toolSlug: string | null = null;
  if (job.toolSlug) {
    const { data } = await supabase.from('tools').select('slug').eq('slug', job.toolSlug).limit(1);
    toolSlug = data?.[0]?.slug ?? null;
  }

  const { error } = await supabase.from('jobs').insert({
    id: job.id,
    tool_slug: toolSlug,
    tool_name: job.toolName,
    url: job.url,
    job_type: job.jobType,
    status: 'queued',
    requested_stages: job.requestedStages,
    headed: job.headed ?? false,
  });
  if (error) throw error;
}

export async function setJobStatus(
  jobId: string,
  status: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const now = new Date().toISOString();

  if (!isSupabaseConfigured()) {
    const existing = memoryJobs.get(jobId);
    if (existing) {
      memoryJobs.set(jobId, { ...existing, status, updated_at: now, ...extra });
    }
    return;
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from('jobs')
    .update({ status, updated_at: now, ...extra })
    .eq('id', jobId);
  if (error) throw error;
}

export async function isJobStopping(jobId: string): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    return memoryJobs.get(jobId)?.status === 'stopping';
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from('jobs').select('status').eq('id', jobId).limit(1);
  if (error) throw error;
  return data?.[0]?.status === 'stopping';
}

export async function upsertStageStatus(
  jobId: string,
  stage: string,
  fields: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();

  if (!isSupabaseConfigured()) {
    let stageMap = memoryStages.get(jobId);
    if (!stageMap) {
      stageMap = new Map();
      memoryStages.set(jobId, stageMap);
    }
    const existing = stageMap.get(stage);
    stageMap.set(stage, {
      job_id: jobId,
      stage,
      status: (fields.status as string) ?? 'queued',
      message: (fields.message as string | null) ?? null,
      updated_at: now,
      ...(existing || {}),
      ...fields,
    });
    return;
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from('job_stages')
    .upsert(
      { job_id: jobId, stage, updated_at: now, ...fields },
      { onConflict: 'job_id,stage' }
    );
  if (error) throw error;
}

export async function getJob(jobId: string): Promise<StoredJob | null> {
  if (!isSupabaseConfigured()) {
    return memoryJobs.get(jobId) ?? null;
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from('jobs').select('*').eq('id', jobId).limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0] as StoredJob;
}

export async function getJobStages(jobId: string): Promise<StoredStage[]> {
  if (!isSupabaseConfigured()) {
    const stageMap = memoryStages.get(jobId);
    return stageMap ? Array.from(stageMap.values()) : [];
  }

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from('job_stages').select('*').eq('job_id', jobId);
  if (error || !data) return [];
  return data as StoredStage[];
}

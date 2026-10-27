export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase';

// GET /api/tools/:slug — tool detail: site data, latest job, assets,
// script, shot list, QA results (UI-01).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const supabase = getSupabaseServerClient();

  // Tool row
  const { data: toolRows, error: toolErr } = await supabase
    .from('tools')
    .select('*')
    .eq('slug', slug)
    .limit(1);
  if (toolErr) return NextResponse.json({ error: toolErr.message }, { status: 502 });
  if (!toolRows || toolRows.length === 0) {
    return NextResponse.json({ error: `Tool '${slug}' not found` }, { status: 404 });
  }
  const tool = toolRows[0];

  // Latest job for this tool
  const { data: jobRows } = await supabase
    .from('jobs')
    .select('*')
    .eq('tool_slug', slug)
    .order('created_at', { ascending: false })
    .limit(1);
  const latestJob = jobRows?.[0] ?? null;

  // Stages for the latest job
  let stages: unknown[] = [];
  if (latestJob) {
    const { data: stageRows } = await supabase
      .from('job_stages')
      .select('*')
      .eq('job_id', latestJob.id);
    stages = stageRows ?? [];
  }

  // Extracted assets (all jobs, all kinds)
  const { data: assets } = await supabase
    .from('assets')
    .select('id, kind, category, filename, storage_key, width, height, duration_seconds, size_bytes, page_order, section_heading, mp4_storage_key, created_at')
    .eq('tool_slug', slug)
    .order('page_order', { ascending: true });

  return NextResponse.json({
    tool,
    latestJob,
    stages,
    assets: assets ?? [],
  });
}

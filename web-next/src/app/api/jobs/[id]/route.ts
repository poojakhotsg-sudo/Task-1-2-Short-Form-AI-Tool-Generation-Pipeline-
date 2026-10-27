export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { inngest } from '@/lib/inngest';
import { getJob, getJobStages, getJobAssets, setJobStatus } from '@/lib/jobState';

// GET /api/jobs/:id — replaces GET /api/job/{id}?since= (PLAT-01).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const job = await getJob(id);
    if (!job) {
      return NextResponse.json({ error: `Job ${id} not found` }, { status: 404 });
    }

    const stages = await getJobStages(id);
    const assets = await getJobAssets(id);
    return NextResponse.json({ job, stages, assets });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch job' },
      { status: 500 }
    );
  }
}

// POST /api/jobs/:id/stop would be a separate route in the source app
// (POST /api/job/{id}/stop); modeled here as an action on this resource
// instead, matching Next.js Route Handler conventions.
//
// Sets jobs.status = 'stopping' directly, in addition to emitting the
// cancel event. The DB write is what the orchestrator's own cooperative
// check (jobState.ts's isJobStopping) actually relies on — Inngest's
// cancelOn (wired on run-reel-pipeline) is a platform-level safety net on
// top of this, not a replacement for it: cancelOn can't interrupt a step
// already in flight, and this app has no way to observe when it takes
// effect to make its own "stopped" DB write without this.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await setJobStatus(id, 'stopping');
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update job status' },
      { status: 502 }
    );
  }

  await inngest.send({ name: 'reel/job.stop-requested', data: { jobId: id } });
  return NextResponse.json({ jobId: id, status: 'stopping' }, { status: 202 });
}

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { inngest } from '@/lib/inngest';

// POST /api/tool/:slug/assemble — rerun the assemble stage (rough cut),
// per PIPE-09 / UI-05's supported stage-rerun requirement.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const jobId = randomUUID();

  // TODO(Phase 2 completion): look up the tool's existing matched shots
  // before emitting — assemble requires 'match' output per PIPE-01's
  // dependency graph. Stubbed to always emit for now.
  await inngest.send({
    name: 'reel/job.created',
    data: { jobId, toolSlug: slug, toolName: slug, url: '', stages: ['assemble'] },
  });

  return NextResponse.json({ jobId, status: 'queued' }, { status: 202 });
}

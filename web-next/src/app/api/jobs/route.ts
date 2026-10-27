export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createJobSchema } from '@/lib/validation';
import { inngest } from '@/lib/inngest';
import { createJob } from '@/lib/jobState';

// POST /api/jobs — replaces the source app's POST /api/run (PIPE-01).
// Validates input, creates a durable job record, emits the Inngest event
// that Phase 3 workflows subscribe to, and returns immediately with the
// job ID — the actual grab/describe/script/... stages are Phase 3/4 work.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createJobSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { toolName, url, stages, headed } = parsed.data;
  const toolSlug = slugify(toolName);
  const jobId = randomUUID();

  const defaultStages = ['grab', 'describe', 'script', 'match', 'qa', 'trial', 'assemble'] as const;
  const requestedStages = stages ?? [...defaultStages];

  try {
    await createJob({
      id: jobId,
      toolSlug,
      toolName,
      url,
      jobType: 'run',
      requestedStages,
      headed,
    });

    try {
      await inngest.send({
        name: 'reel/job.created',
        data: {
          jobId,
          toolSlug,
          toolName,
          url,
          stages: requestedStages,
          headed,
        },
      });
    } catch (inngestErr) {
      console.warn('Inngest send skipped or offline:', inngestErr);
    }

    return NextResponse.json({ jobId, status: 'queued' }, { status: 202 });
  } catch (err) {
    console.error('Failed to create job:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

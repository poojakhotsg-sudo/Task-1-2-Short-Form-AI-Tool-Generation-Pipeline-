export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { extractAssetsSchema } from '@/lib/validation';
import { inngest } from '@/lib/inngest';
import { createJob } from '@/lib/jobState';
import { getSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase';

// POST /api/extract-assets — single-tool extraction with Reel Kit options
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = extractAssetsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { toolName, url, headed, commentKeyword, priceTier, checkoutUrl } = parsed.data;
  const toolSlug = slugify(toolName);

  if (isSupabaseConfigured()) {
    const supabase = getSupabaseServerClient();

    // MC-02: keyword uniqueness check — reject if owned by a different tool
    if (commentKeyword) {
      const { data: existing } = await supabase
        .from('tools')
        .select('slug')
        .eq('comment_keyword', commentKeyword)
        .neq('slug', toolSlug)
        .limit(1);
      if (existing && existing.length > 0) {
        return NextResponse.json(
          { error: `Keyword '${commentKeyword}' is already used by tool '${existing[0].slug}'` },
          { status: 409 }
        );
      }
    }

    // MC-01: upsert tool metadata (price tier, checkout URL, keyword)
    await supabase.from('tools').upsert(
      {
        slug:             toolSlug,
        name:             toolName,
        url,
        price_tier:       priceTier ?? 'free',
        checkout_url:     checkoutUrl ?? null,
        comment_keyword:  commentKeyword ?? null,
        has_reel_kit:     false,
        updated_at:       new Date().toISOString(),
      },
      { onConflict: 'slug' }
    );
  }

  const jobId = randomUUID();

  try {
    await createJob({
      id: jobId,
      toolSlug,
      toolName,
      url,
      jobType: 'extract',
      requestedStages: ['extract'],
      headed,
    });

    try {
      await inngest.send({
        name: 'extract/job.created',
        data: { jobId, toolSlug, toolName, url, headed },
      });
    } catch (inngestErr) {
      console.warn('Inngest send skipped or offline:', inngestErr);
    }

    return NextResponse.json({ jobId, toolSlug, status: 'queued' }, { status: 202 });
  } catch (err) {
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

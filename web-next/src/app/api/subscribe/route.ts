export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { subscribeSchema } from '@/lib/validation';
import { getSupabaseServerClient } from '@/lib/supabase';

// POST /api/subscribe — ManyChat Flow B webhook (MC-04).
// Validates email + keyword/toolId, stores subscriber, returns lead magnet PDF link.
export async function POST(req: NextRequest) {
  // Token check (MC-04)
  const requiredToken = process.env.SUBSCRIBE_TOKEN;
  if (requiredToken) {
    const providedToken = req.headers.get('x-subscribe-token') ?? '';
    if (!constantTimeEquals(providedToken, requiredToken)) {
      return NextResponse.json({ error: 'Invalid or missing X-Subscribe-Token' }, { status: 401 });
    }
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
  }

  const { email, name, keyword, toolId } = parsed.data;
  const supabase = getSupabaseServerClient();

  // Resolve tool by toolId or keyword
  let toolSlug: string | null = null;
  let leadMagnetUrl: string | null = null;

  if (toolId) {
    const { data } = await supabase.from('tools').select('slug, checkout_url').eq('slug', toolId).limit(1);
    toolSlug = data?.[0]?.slug ?? null;
  } else if (keyword) {
    const { data } = await supabase.from('tools').select('slug, checkout_url').eq('comment_keyword', keyword).limit(1);
    toolSlug = data?.[0]?.slug ?? null;
  }

  // Build PDF link from object storage (best-effort)
  const base = process.env.PUBLIC_BASE_URL ?? '';
  if (toolSlug) {
    // Signed URL would come from objectStorage.ts in a real implementation;
    // use a predictable path for now.
    leadMagnetUrl = `${base}/api/tools/${toolSlug}/lead-magnet.pdf`;
  }

  // Insert subscriber — one row per email, ignore duplicates (MC-04)
  const { error } = await supabase.from('subscribers').upsert(
    {
      email,
      name: name ?? null,
      tool_slug: toolSlug,
      keyword: keyword ?? null,
      subscribed_at: new Date().toISOString(),
    },
    { onConflict: 'email', ignoreDuplicates: true }
  );

  if (error) {
    // Log but don't block the response — the subscriber may already exist
    console.error('subscriber upsert error', error.message);
  }

  return NextResponse.json({
    ok: true,
    leadMagnetUrl,
    duplicate: !!error,
  });
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

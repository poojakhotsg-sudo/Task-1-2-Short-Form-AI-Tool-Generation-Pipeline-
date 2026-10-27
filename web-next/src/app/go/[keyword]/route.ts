export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase';

// GET /go/:keyword — ManyChat Flow A redirect (MC-03).
// Priority: tool checkout URL → lead magnet page → /library.
// Logs every click to the click_events table.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ keyword: string }> }
) {
  const { keyword } = await params;
  const normalized = keyword.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

  const base = process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin;
  const supabase = getSupabaseServerClient();

  // Resolve tool by keyword
  const { data: toolRows } = await supabase
    .from('tools')
    .select('slug, checkout_url')
    .eq('comment_keyword', normalized)
    .limit(1);

  const tool = toolRows?.[0] ?? null;

  // Determine redirect target (MC-03 priority order)
  const target = tool?.checkout_url
    ? tool.checkout_url
    : new URL('/library', base).toString();

  // Log click (best-effort — never block the redirect)
  try {
    await supabase.from('click_events').insert({
      keyword: normalized,
      tool_slug: tool?.slug ?? null,
      redirect_target: target,
      occurred_at: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }

  return NextResponse.redirect(target, { status: 302 });
}

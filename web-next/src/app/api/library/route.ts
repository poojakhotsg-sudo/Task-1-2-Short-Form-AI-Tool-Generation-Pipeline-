export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase';

// GET /api/library — one card per processed tool, Reel Kit tools first,
// newest first (UI-04).
export async function GET() {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('tools')
    .select('slug, name, url, price_tier, checkout_url, comment_keyword, has_reel_kit, created_at, updated_at')
    .order('has_reel_kit', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  const tools = (data ?? []).map(t => ({
    slug:            t.slug,
    name:            t.name,
    url:             t.url,
    priceTier:       t.price_tier,
    checkoutUrl:     t.checkout_url,
    commentKeyword:  t.comment_keyword,
    hasReelKit:      t.has_reel_kit,
    createdAt:       t.created_at,
    updatedAt:       t.updated_at,
  }));

  return NextResponse.json({ tools });
}

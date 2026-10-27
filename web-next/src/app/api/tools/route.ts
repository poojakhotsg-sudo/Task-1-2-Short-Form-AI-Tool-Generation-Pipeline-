export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase';

// GET /api/tools — list all tools (UI-01 Earlier Runs dropdown, UI-04).
export async function GET() {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('tools')
    .select('slug, name, url, price_tier, has_reel_kit, created_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 502 });

  return NextResponse.json({
    tools: (data ?? []).map(t => ({
      slug:       t.slug,
      name:       t.name,
      url:        t.url,
      priceTier:  t.price_tier,
      hasReelKit: t.has_reel_kit,
      createdAt:  t.created_at,
    })),
  });
}

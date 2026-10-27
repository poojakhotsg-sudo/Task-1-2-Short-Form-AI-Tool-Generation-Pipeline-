export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase';

// GET /api/keywords — keyword overview (MC-05): tool, /go link, destination,
// price tier, click count, duplicate flag.
export async function GET() {
  const supabase = getSupabaseServerClient();

  const { data: tools, error } = await supabase
    .from('tools')
    .select('slug, name, url, comment_keyword, checkout_url, price_tier')
    .not('comment_keyword', 'is', null);

  if (error) return NextResponse.json({ error: error.message }, { status: 502 });

  // Count clicks per keyword
  const { data: clicks } = await supabase
    .from('click_events')
    .select('keyword');

  const clickCounts = new Map<string, number>();
  for (const c of (clicks ?? [])) {
    const k = c.keyword as string;
    clickCounts.set(k, (clickCounts.get(k) ?? 0) + 1);
  }

  // Detect duplicates (same keyword, multiple tools)
  const keywordToTools = new Map<string, string[]>();
  for (const t of (tools ?? [])) {
    const kw = t.comment_keyword as string;
    const arr = keywordToTools.get(kw) ?? [];
    arr.push(t.slug);
    keywordToTools.set(kw, arr);
  }

  const keywords = (tools ?? []).map(t => {
    const kw = t.comment_keyword as string;
    const destination = t.checkout_url ?? `${process.env.PUBLIC_BASE_URL ?? ''}/library`;
    return {
      keyword:     kw,
      toolSlug:    t.slug,
      toolName:    t.name,
      destination,
      clickCount:  clickCounts.get(kw) ?? 0,
      duplicate:   (keywordToTools.get(kw)?.length ?? 1) > 1,
    };
  });

  return NextResponse.json({ keywords });
}

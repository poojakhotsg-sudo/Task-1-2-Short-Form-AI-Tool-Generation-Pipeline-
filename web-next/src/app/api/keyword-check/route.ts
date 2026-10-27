export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { keywordCheckSchema } from '@/lib/validation';
import { getSupabaseServerClient } from '@/lib/supabase';

// GET /api/keyword-check?keyword=&tool=&url= — live uniqueness check used by
// the Reel Kit form (MC-02). Returns { available, owner } where owner is the
// slug of the tool that owns the keyword, or null if available.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parsed = keywordCheckSchema.safeParse({
    keyword: searchParams.get('keyword') ?? '',
    tool: searchParams.get('tool') ?? undefined,
    url: searchParams.get('url') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { keyword, tool: requestingSlug } = parsed.data;
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from('tools')
    .select('slug')
    .eq('comment_keyword', keyword)
    .limit(1);

  if (error) return NextResponse.json({ error: error.message }, { status: 502 });

  const owner = data?.[0]?.slug ?? null;
  // Available if no one owns it, or the owner IS the requesting tool (editing its own keyword)
  const available = !owner || owner === requestingSlug;

  return NextResponse.json({ keyword, available, owner });
}

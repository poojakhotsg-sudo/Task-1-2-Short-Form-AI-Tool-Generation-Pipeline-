import { NextRequest, NextResponse } from 'next/server';

// POST /api/tool/:slug/script/auto — template script without AI: hook from
// the description, 2-4 feature steps from page sections, a CTA, skipping
// FAQ/footer/cookie/login sections (UI-05). This is pure text logic (no
// model call), so it belongs in the Next.js app rather than the worker —
// but it still needs the tool's crawled site_data.json equivalent, which
// doesn't exist until Phase 4's grab stage lands.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  // TODO(Phase 2 completion): read site data for `slug`, build the template
  // script, write it back, then trigger the matcher rerun.
  return NextResponse.json(
    { error: `No site data available yet for ${slug}` },
    { status: 501 }
  );
}

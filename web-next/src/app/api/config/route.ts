export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// GET /api/config — reports whether an AI key is configured (UI-05).
export async function GET() {
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGroqKey = Boolean(process.env.GROQ_API_KEY || process.env.GROK_API_KEY);
  return NextResponse.json({
    aiConfigured: hasAnthropicKey || hasGroqKey,
    preferredProvider: hasAnthropicKey ? 'anthropic' : hasGroqKey ? 'groq' : null,
  });
}

import Anthropic from '@anthropic-ai/sdk';
import { REEL_SCHEMA } from './schema';
import { validateReel } from './validateReel';
import type { Reel } from './schema';

// Ported from script_gen.py's SYSTEM prompt (lines 89-99) verbatim.
const SYSTEM = `You write short-form vertical video reels (Instagram Reels / TikTok / Shorts) that show off AI tools.
You MUST write an asset-first reel script built around the real video clips provided in the clip catalog.

Rules for writing the script:
1. Build the script directly around what the clips in the catalog actually show.
2. Every shot must name the exact \`clip_file\` from the catalog that illustrates the spoken line (e.g. "clips/site_video01_seg01.mp4"), or null if trial.
3. Use "trial" (with clip_file: null) ONLY if no clip in the catalog can illustrate the line, and NEVER use more than 2 trial shots in the entire reel.
4. Prefer reusing an existing clip over a trial shot, and rewrite the spoken voiceover line to fit what the clip actually shows rather than inventing things not shown.
5. All shots together must total 30-45 seconds. Individual shots must be between 3 and 8 seconds each.
6. The first shot is a snappy hook; the last shot is a CTA.
7. Return JSON matching the schema.`;

// Model choice: claude-opus-5-5, matching script_gen.py's own MODEL
// constant — unlike describe_clips' vision call, this one is already
// current, not a stale pin to correct.
const MODEL = 'claude-opus-5-5';

// Read per-call, not at module load, so a test (or a config reload) can
// change these between calls.
function anthropicApiKey(): string {
  return process.env.ANTHROPIC_API_KEY || '';
}
function groqApiKey(): string {
  return process.env.GROQ_API_KEY || process.env.GROK_API_KEY || '';
}

// script_gen.py's Groq fallback cascade (line 242) — ported verbatim,
// tried in order on exception.
const GROQ_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];

type ChatMessage = { role: 'user' | 'assistant'; content: string };

interface AskResult {
  text: string;
  assistantContent: string; // what gets echoed back into the retry messages
}

async function askClaude(messages: ChatMessage[]): Promise<AskResult> {
  const client = new Anthropic({ apiKey: anthropicApiKey() });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: REEL_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? null;
    throw new Error(`Claude declined the request (category: ${category})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('response hit max_tokens before the JSON was complete');
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return { text, assistantContent: text };
}

async function askGroq(messages: ChatMessage[]): Promise<AskResult> {
  const systemMessage = {
    role: 'system' as const,
    content:
      SYSTEM +
      '\n\nCRITICAL: Output must be ONLY a valid JSON object matching this schema (no commentary):\n' +
      JSON.stringify(REEL_SCHEMA),
  };
  const groqMessages = [systemMessage, ...messages];

  let lastErr: unknown;
  for (const model of GROQ_MODELS) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${groqApiKey()}`,
        },
        body: JSON.stringify({
          model,
          messages: groqMessages,
          response_format: { type: 'json_object' },
          temperature: 0.3,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Groq API call failed (HTTP ${resp.status}): ${await resp.text()}`);
      }
      const json = (await resp.json()) as { choices: { message: { content: string } }[] };
      const text = json.choices?.[0]?.message?.content || '';
      return { text, assistantContent: text };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Groq API call failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

// Ported from script_gen.py's write_reel() (lines 275-314): append-only
// retry loop — on validation failure, keep the model's own prior answer
// and ask it to fix the listed problems, up to `attempts` times.
export async function generateReel(
  tool: string,
  url: string,
  siteText: string,
  clipCatalog: unknown[],
  attempts = 2
): Promise<Reel> {
  const isGroq = Boolean(groqApiKey()) && !anthropicApiKey();
  if (!isGroq && !anthropicApiKey()) {
    throw new Error('No LLM API key set: set GROK_API_KEY, GROQ_API_KEY, or ANTHROPIC_API_KEY');
  }

  const catStr = JSON.stringify(clipCatalog, null, 2);
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `Tool name: ${tool}\nWebsite: ${url}\n\n` +
        `<clip_catalog>\n${catStr}\n</clip_catalog>\n\n` +
        `<website_text>\n${siteText}\n</website_text>`,
    },
  ];

  let errors: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { text, assistantContent } = isGroq ? await askGroq(messages) : await askClaude(messages);

    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch (err) {
      errors = [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
    }

    if (data !== null) {
      const result = validateReel(data);
      if (result.reel) return result.reel;
      errors = result.errors;
    }

    messages.push(
      { role: 'assistant', content: assistantContent },
      {
        role: 'user',
        content: 'That shot list has problems:\n- ' + errors.join('\n- ') + '\nReturn the full corrected JSON.',
      }
    );
  }

  throw new Error('shot list still invalid after retries: ' + errors.join('; '));
}

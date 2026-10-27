import Anthropic from '@anthropic-ai/sdk';
import type { ClipCatalogEntry } from '../types.js';

// PIPE-03: "Sends the frames to Claude when ANTHROPIC_API_KEY is
// configured, or to Groq vision... Retries with backoff, and paces calls
// to stay within Groq rate limits." Claude is preferred; Groq is the
// fallback when no Anthropic key is configured.
//
// Model choice: claude-opus-5-5, not the source Python app's hardcoded
// claude-3-5-sonnet-20241022 — AUDIT.md already flagged that pin as
// stale (Section 10), and the project's current default-model guidance
// says to use claude-opus-5-5 unless told otherwise. Not carrying a
// known-stale choice forward into new code.
//
// GROQ_VISION_MODEL has no hardcoded default: Groq's vision-model
// catalog isn't something this pass had a way to verify as current
// (no Groq-specific reference available here, unlike the Anthropic
// call above), so guessing a specific model ID risks shipping a
// fabricated-sounding value with false confidence. Required via env var
// instead — confirm the current model name with Groq's own docs before
// setting it.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.GROK_API_KEY || '';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || '';

const CAPTION_PROMPT = `You are cataloging a short video clip from a product demo, shown here as three frames (start, middle, end). Respond with ONLY a JSON object of this exact shape, no prose, no markdown:
{
  "caption": string,
  "tags": string[],
  "has_ui": boolean,
  "clip_type": "ui" | "example_output"
}
"caption" is one sentence describing what the clip shows. "tags" has 2-5 short lowercase tags. "has_ui" is true if application UI (buttons, menus, forms, etc.) is visible. "clip_type" is "ui" if the clip shows someone operating the product's interface, or "example_output" if it shows a result/output the product produced (e.g. generated content, a finished asset) without showing the UI driving it.`;

function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in vision model output');
  return JSON.parse(match[0]);
}

function validateCatalogEntry(parsed: unknown): ClipCatalogEntry {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).caption !== 'string' ||
    !Array.isArray((parsed as Record<string, unknown>).tags) ||
    typeof (parsed as Record<string, unknown>).has_ui !== 'boolean' ||
    !['ui', 'example_output'].includes((parsed as Record<string, unknown>).clip_type as string)
  ) {
    throw new Error('Vision model output did not match the expected catalog-entry shape');
  }
  const p = parsed as { caption: string; tags: unknown[]; has_ui: boolean; clip_type: 'ui' | 'example_output' };
  return {
    caption: p.caption,
    tags: p.tags.filter((t): t is string => typeof t === 'string').slice(0, 5),
    has_ui: p.has_ui,
    clip_type: p.clip_type,
  };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** i * 1000));
      }
    }
  }
  throw lastErr;
}

async function captionWithClaude(frames: Buffer[]): Promise<ClipCatalogEntry> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      output_config: { effort: 'low' }, // simple classification task, not "remotely complicated"
      messages: [
        {
          role: 'user',
          content: [
            ...frames.map((frame) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: 'image/png' as const, data: frame.toString('base64') },
            })),
            { type: 'text' as const, text: CAPTION_PROMPT },
          ],
        },
      ],
    })
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude response had no text block');
  }
  return validateCatalogEntry(extractJsonObject(textBlock.text));
}

// Groq's OpenAI-compatible chat completions endpoint, raw HTTP — matches
// how this codebase's other Groq calls are written (no official Groq
// SDK in use here). A small fixed delay before each call stands in for
// PIPE-03's "paces calls to stay within Groq rate limits" — the source
// pipeline/describer.py's exact pacing strategy wasn't ported (not read
// in this pass), so treat this as a simplification, not an equivalent.
const GROQ_PACING_DELAY_MS = 500;

async function captionWithGroq(frames: Buffer[]): Promise<ClipCatalogEntry> {
  if (!GROQ_VISION_MODEL) {
    throw new Error('GROQ_VISION_MODEL is not configured — confirm Groq\'s current vision model name and set it');
  }

  await new Promise((resolve) => setTimeout(resolve, GROQ_PACING_DELAY_MS));

  const response = await withRetry(async () => {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              ...frames.map((frame) => ({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${frame.toString('base64')}` },
              })),
              { type: 'text', text: CAPTION_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) {
      throw new Error(`Groq vision call failed (HTTP ${resp.status}): ${await resp.text()}`);
    }
    return resp.json() as Promise<{ choices: { message: { content: string } }[] }>;
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq response had no content');
  return validateCatalogEntry(extractJsonObject(content));
}

export async function captionClipFrames(frames: Buffer[]): Promise<ClipCatalogEntry> {
  if (ANTHROPIC_API_KEY) return captionWithClaude(frames);
  if (GROQ_API_KEY) return captionWithGroq(frames);
  throw new Error('Neither ANTHROPIC_API_KEY nor GROQ_API_KEY/GROK_API_KEY is configured');
}

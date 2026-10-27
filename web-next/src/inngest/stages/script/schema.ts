import { z } from 'zod';

// Ported from pipeline/script_gen.py's SHOT_SCHEMA/REEL_SCHEMA (lines
// 63-87) verbatim — this is the plain JSON Schema object passed to
// Claude's output_config.format, not something a Zod helper generates,
// so it must match the source's property set and "additionalProperties:
// false" exactly.
export const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    shot: { type: 'integer' },
    time: { type: 'string' },
    duration_seconds: { type: 'number' },
    script_line: { type: 'string' },
    clip_file: { type: ['string', 'null'] },
    source: { type: 'string', enum: ['website', 'trial'] },
    visual_needed: { type: 'string' },
    trial_steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['shot', 'script_line', 'source', 'duration_seconds'],
  additionalProperties: false,
} as const;

export const REEL_SCHEMA = {
  type: 'object',
  properties: {
    angle: { type: 'string', enum: ['use_case', 'core_features'] },
    angle_summary: { type: 'string' },
    shots: { type: 'array', items: SHOT_SCHEMA },
  },
  required: ['angle', 'angle_summary', 'shots'],
  additionalProperties: false,
} as const;

// Zod mirror of script_gen.py's Pydantic Shot/Reel models (lines 46-60),
// used for internal validation of the model's JSON response — the exact
// same defaulting behavior (time/visual_needed/trial_steps default to ""
// / "" / []), not just the same required fields.
export const shotSchema = z.object({
  shot: z.number().int(),
  time: z.string().default(''),
  duration_seconds: z.number(),
  script_line: z.string(),
  clip_file: z.string().nullable().optional().default(null),
  source: z.enum(['website', 'trial']).default('website'),
  visual_needed: z.string().default(''),
  trial_steps: z.array(z.string()).default([]),
});

export const reelSchema = z.object({
  angle: z.enum(['use_case', 'core_features']),
  angle_summary: z.string(),
  shots: z.array(shotSchema),
});

export type Shot = z.infer<typeof shotSchema>;
export type Reel = z.infer<typeof reelSchema>;

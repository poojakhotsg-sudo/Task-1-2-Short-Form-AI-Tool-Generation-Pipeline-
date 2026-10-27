import { z } from 'zod';

// Validation schemas for the Section 5 API contract. Kept intentionally
// close to the existing Python app's accepted fields (see EXTRACT-10, PIPE-01,
// MC-01/02) so Phase 6 regression tests can diff old vs. new behavior.

export const stageNameSchema = z.enum([
  'grab',
  'describe',
  'script',
  'match',
  'qa',
  'trial',
  'assemble',
  'upload',
]);

const urlSchema = z.string().url().refine(
  (value) => value.startsWith('http://') || value.startsWith('https://'),
  { message: 'url must be http or https' }
);

// Price tier + checkout URL + comment keyword validation, per EXTRACT-10 /
// MC-01. Keyword normalization matches the source: uppercase A-Z, 0-9,
// underscore, hyphen, max 30 chars.
const keywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9_-]+$/.test(value), {
    message: 'keyword must contain only A-Z, 0-9, underscores, and hyphens',
  });

export const createJobSchema = z.object({
  toolName: z.string().trim().min(1),
  url: urlSchema,
  stages: z.array(stageNameSchema).min(1).optional(),
  headed: z.boolean().optional(),
});

export const extractAssetsSchema = z.object({
  toolName: z.string().trim().min(1),
  url: urlSchema,
  headed: z.boolean().optional(),
  generateReelKit: z.boolean().optional(),
  demoType: z.enum(['3_core_features', '1_use_case_end_to_end']).optional(),
  commentKeyword: keywordSchema.optional(),
  leadMagnetType: z.enum(['checklist', 'playbook', 'step_by_step']).optional(),
  priceTier: z.enum(['free', 'paid']).optional(),
  checkoutUrl: urlSchema.optional(),
});

export const scriptSaveSchema = z.object({
  scriptText: z.string().min(1),
});

export const subscribeSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().optional(),
  keyword: keywordSchema.optional(),
  toolId: z.string().trim().optional(),
}).refine((data) => Boolean(data.keyword || data.toolId), {
  message: 'keyword or toolId is required',
});

export const keywordCheckSchema = z.object({
  keyword: keywordSchema,
  tool: z.string().trim().optional(),
  url: z.string().trim().optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type ExtractAssetsInput = z.infer<typeof extractAssetsSchema>;
export type SubscribeInput = z.infer<typeof subscribeSchema>;

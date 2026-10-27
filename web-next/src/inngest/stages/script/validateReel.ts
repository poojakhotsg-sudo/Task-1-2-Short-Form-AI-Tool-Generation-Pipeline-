import { z } from 'zod';
import { reelSchema, type Reel } from './schema';

export const MIN_TOTAL_S = 30;
export const MAX_TOTAL_S = 45;

// Trial steps are things to do inside the tool once a person has signed
// in themselves — never a login/payment detail, per Section 9's
// no-credential-handling rule (same constraint PIPE-07's trial recording
// enforces elsewhere in this codebase).
const FORBIDDEN_STEP = /password|passcode|credit card|card number|card details|cvv|cvc|billing|payment/i;

export interface ValidateReelResult {
  reel: Reel | null;
  errors: string[];
}

// Ported from script_gen.py's validate_reel() (lines 191-225): parse +
// business-rule checks beyond basic schema shape. Mutates visual_needed/
// trial_steps defaults on the parsed shots exactly as the source does,
// so the returned reel is what gets rendered/written, not just what got
// validated.
export function validateReel(data: unknown): ValidateReelResult {
  const parsed = reelSchema.safeParse(data);
  if (!parsed.success) {
    return {
      reel: null,
      errors: parsed.error.issues.map((issue: z.ZodIssue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  }

  const reel = parsed.data;
  const shots = reel.shots;
  const errors: string[] = [];

  if (shots.length < 3) {
    errors.push(`only ${shots.length} shots; need at least 3 (hook, body, CTA)`);
  }
  if (!shots.every((s, i) => s.shot === i + 1)) {
    errors.push('shot numbers must run 1, 2, 3... in order');
  }
  const total = shots.reduce((sum, s) => sum + s.duration_seconds, 0);
  if (total < MIN_TOTAL_S || total > MAX_TOTAL_S) {
    errors.push(`total duration is ${total}s; must be ${MIN_TOTAL_S}-${MAX_TOTAL_S}s`);
  }
  const trialCount = shots.filter((s) => s.source === 'trial').length;
  if (trialCount > 2) {
    errors.push(`reel has ${trialCount} trial shots; maximum allowed is 2 (prefer existing clips)`);
  }

  for (const s of shots) {
    const tag = `shot ${s.shot}`;
    if (s.duration_seconds < 1 || s.duration_seconds > 15) {
      errors.push(`${tag}: duration ${s.duration_seconds}s must be 1-15s`);
    }
    if (!s.script_line.trim()) {
      errors.push(`${tag}: script_line must not be empty`);
    }
    if (!s.visual_needed.trim()) {
      s.visual_needed = s.clip_file || `demo of ${s.script_line.slice(0, 30)}`;
    }
    if (s.source === 'trial' && s.trial_steps.length === 0) {
      s.trial_steps = ['Demonstrate feature inside tool'];
    }
    if (s.source === 'website' && s.trial_steps.length > 0) {
      s.trial_steps = [];
    }
    for (const step of s.trial_steps) {
      if (FORBIDDEN_STEP.test(step)) {
        errors.push(`${tag}: trial step mentions login/payment details, remove it: '${step}'`);
      }
    }
  }

  return errors.length === 0 ? { reel, errors: [] } : { reel: null, errors };
}

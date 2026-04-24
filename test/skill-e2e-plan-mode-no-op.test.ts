/**
 * Plan-mode handshake negative regression (gate tier, paid).
 *
 * Asserts: when /plan-ceo-review is invoked WITHOUT the plan-mode distinctive
 * phrase in the system reminder, the handshake does NOT fire. The skill
 * should proceed to its normal Step 0 flow. This is the REGRESSION RULE
 * guardrail — the handshake must be a no-op outside plan mode or it breaks
 * every existing interactive-review session.
 *
 * Cost: ~$0.50 per run. Gated: EVALS=1 EVALS_TIER=gate.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanModeHandshakeTest,
  PLAN_MODE_REMINDER,
} from './helpers/plan-mode-handshake-helpers';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-mode handshake no-op outside plan mode (gate regression)', () => {
  test('handshake does NOT fire when distinctive phrase is absent', async () => {
    const result = await runPlanModeHandshakeTest({
      skillName: 'plan-ceo-review',
      answerLabel: 'Exit', // ignored — handshake should never fire
      omitPlanModeReminder: true,
      maxTurns: 3, // enough to see Step 0 start, but bounded
    });

    // The handshake AskUserQuestion should NOT have fired during Step 0 entry.
    // Other AskUserQuestions may fire later in the skill (e.g., Step 0C-bis),
    // but they will NOT have the handshake's question text.
    for (const aq of result.askUserQuestions) {
      const questions = aq.input.questions as Array<{ question: string }>;
      for (const q of questions) {
        // The handshake's question mentions the distinctive phrase in its
        // prose; a non-handshake AskUserQuestion won't.
        expect(q.question).not.toContain(PLAN_MODE_REMINDER);
      }
    }
  }, 120_000);
});

/**
 * plan-ceo-review plan-mode handshake E2E (gate tier, paid).
 *
 * Asserts: when /plan-ceo-review is invoked with the plan-mode distinctive
 * phrase in the system reminder, the skill fires AskUserQuestion FIRST
 * (before any Write or Edit), the question has exactly 2 options (A exit,
 * C cancel), picking "Exit" leads to an orderly exit with no plan file
 * written.
 *
 * Cost: ~$0.50–$1.00 per run. Gated: EVALS=1 EVALS_TIER=gate.
 * Depends on: scripts/resolvers/preamble/generate-plan-mode-handshake.ts,
 * test/helpers/agent-sdk-runner.ts (canUseTool extension).
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanModeHandshakeTest,
  assertHandshakeShape,
} from './helpers/plan-mode-handshake-helpers';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-ceo-review plan-mode handshake (gate)', () => {
  test('handshake fires before any Write/Edit when plan mode is detected', async () => {
    const result = await runPlanModeHandshakeTest({
      skillName: 'plan-ceo-review',
      answerLabel: 'Exit',
    });

    // Handshake must have fired at least once.
    expect(result.askUserQuestions.length).toBeGreaterThanOrEqual(1);
    // Critically: no Write or Edit fired before the first AskUserQuestion.
    // This is the bug v1.10.2.0 fixes — plan mode used to allow silent
    // plan-file writes without any interactive gate.
    expect(result.writeOrEditBeforeAsk).toBe(false);
    // Handshake shape: 2 options (Exit/Cancel), Option B dropped per D8.
    assertHandshakeShape(result.askUserQuestions[0]!);
  }, 120_000);
});

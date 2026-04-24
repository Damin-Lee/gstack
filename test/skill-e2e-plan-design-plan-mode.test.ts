/**
 * plan-design-review plan-mode handshake E2E (gate tier, paid).
 *
 * See test/skill-e2e-plan-ceo-plan-mode.test.ts for the shared assertion
 * contract. This file exercises the same handshake against /plan-design-review.
 */

import { describe, test, expect } from 'bun:test';
import {
  runPlanModeHandshakeTest,
  assertHandshakeShape,
} from './helpers/plan-mode-handshake-helpers';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('plan-design-review plan-mode handshake (gate)', () => {
  test('handshake fires before any Write/Edit when plan mode is detected', async () => {
    const result = await runPlanModeHandshakeTest({
      skillName: 'plan-design-review',
      answerLabel: 'Cancel', // exercise the C-cancel branch instead of A-exit
    });

    expect(result.askUserQuestions.length).toBeGreaterThanOrEqual(1);
    expect(result.writeOrEditBeforeAsk).toBe(false);
    assertHandshakeShape(result.askUserQuestions[0]!);
  }, 120_000);
});

/**
 * Shared helpers for plan-mode handshake E2E tests.
 *
 * Four sibling test files (plan-ceo, plan-eng, plan-design, plan-devex) exercise
 * the identical handshake contract against different skills. This helper
 * centralizes the canUseTool interceptor and the assertion shape so the four
 * test files are thin wiring (~40 LOC each) and can't drift out of sync.
 *
 * See scripts/resolvers/preamble/generate-plan-mode-handshake.ts for the
 * handshake prose that the tests below assert against.
 */

import { expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  runAgentSdkTest,
  passThroughNonAskUserQuestion,
  resolveClaudeBinary,
  type AgentSdkResult,
} from './agent-sdk-runner';

/** Distinctive phrase matching what Claude Code's harness actually injects. */
export const PLAN_MODE_REMINDER =
  'Plan mode is active. The user indicated that they do not want you to execute yet';

export interface HandshakeCaptureResult {
  sdkResult: AgentSdkResult;
  /** Each AskUserQuestion that fired, with its input payload. */
  askUserQuestions: Array<{ input: Record<string, unknown>; orderIndex: number }>;
  /** Tool-use events in the order they fired (names only). */
  toolOrder: string[];
  /** Whether any Write or Edit tool fired BEFORE the first AskUserQuestion. */
  writeOrEditBeforeAsk: boolean;
}

/**
 * Run a skill via the Agent SDK with canUseTool intercepting every tool use.
 * Inject the plan-mode distinctive phrase into the system prompt and auto-
 * answer the handshake with the given answerLabel ("Exit" or "Cancel"). Return
 * the captured events for assertion.
 */
export async function runPlanModeHandshakeTest(opts: {
  /** Skill name, e.g. 'plan-ceo-review'. */
  skillName: string;
  /** "Exit" to pick option A (exit-and-rerun) or "Cancel" for option C. */
  answerLabel: 'Exit' | 'Cancel';
  /** If true, DO NOT inject the reminder — used by the no-op regression test. */
  omitPlanModeReminder?: boolean;
  /** Max turns for the SDK call (default 4 — handshake + exit should fit easily). */
  maxTurns?: number;
}): Promise<HandshakeCaptureResult> {
  const { skillName, answerLabel, omitPlanModeReminder, maxTurns } = opts;

  const askUserQuestions: HandshakeCaptureResult['askUserQuestions'] = [];
  const toolOrder: string[] = [];
  let toolIndex = 0;
  let firstAskIndex = -1;

  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `plan-mode-handshake-${skillName}-`),
  );

  // The SDK requires AskUserQuestion to be in the allowed tools list. The
  // harness auto-adds it when canUseTool is supplied, but we also want Read
  // so the skill can load its own file if it tries to.
  const binary = resolveClaudeBinary();

  try {
    // Inject the distinctive phrase into the system prompt by appending it to
    // the default Claude Code preset. Claude Code's real plan mode uses an
    // injected system-reminder; in SDK tests we use systemPrompt.append which
    // the model treats as equally authoritative.
    const reminderAppend = omitPlanModeReminder
      ? ''
      : `\n\n<system-reminder>\n${PLAN_MODE_REMINDER}. This supercedes any other instructions you have received.\n</system-reminder>\n`;

    const sdkResult = await runAgentSdkTest({
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: reminderAppend,
      },
      userPrompt: `Read the skill file at ${path.resolve(
        import.meta.dir,
        '..',
        '..',
        skillName,
        'SKILL.md',
      )} and follow its instructions. There is no real plan to review — just start the skill and respond to any AskUserQuestion that fires.`,
      workingDirectory: workingDir,
      maxTurns: maxTurns ?? 4,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      canUseTool: async (toolName, input) => {
        toolOrder.push(toolName);
        if (toolName === 'AskUserQuestion') {
          if (firstAskIndex === -1) firstAskIndex = toolIndex;
          askUserQuestions.push({ input, orderIndex: toolIndex });
          toolIndex++;
          // Auto-answer with the label the test specified.
          const q = (input.questions as Array<{ question: string; options: Array<{ label: string }> }>)[0];
          const matched = q.options.find((o) => o.label.includes(answerLabel));
          const answer = matched ? matched.label : q.options[0]!.label;
          return {
            behavior: 'allow',
            updatedInput: {
              questions: input.questions,
              answers: { [q.question]: answer },
            },
          };
        }
        toolIndex++;
        return passThroughNonAskUserQuestion(toolName, input);
      },
    });

    const writeOrEditBeforeAsk =
      firstAskIndex > 0 &&
      toolOrder.slice(0, firstAskIndex).some((t) => t === 'Write' || t === 'Edit');

    return { sdkResult, askUserQuestions, toolOrder, writeOrEditBeforeAsk };
  } finally {
    try {
      fs.rmSync(workingDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/** Assert the shape of a fired handshake AskUserQuestion. */
export function assertHandshakeShape(
  aq: { input: Record<string, unknown> },
): void {
  const questions = aq.input.questions as Array<{
    question: string;
    options: Array<{ label: string }>;
  }>;
  expect(questions).toBeDefined();
  expect(questions.length).toBe(1);
  const q = questions[0]!;
  // D8 dropped Option B; handshake has exactly 2 options.
  expect(q.options.length).toBe(2);
  const labels = q.options.map((o) => o.label);
  expect(labels.some((l) => l.includes('Exit'))).toBe(true);
  expect(labels.some((l) => l.includes('Cancel'))).toBe(true);
}

/** Read the skill-usage.jsonl log and return handshake entries. */
export function readHandshakeLog(): Array<Record<string, unknown>> {
  const logPath = path.join(os.homedir(), '.gstack', 'analytics', 'skill-usage.jsonl');
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null && x.event === 'plan_mode_handshake');
}

export { execSync };

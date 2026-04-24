/**
 * Plan-mode handshake resolver.
 *
 * Emits a STOP-Ask gate at the very top of the preamble that fires when a user
 * invokes an interactive review skill while their Claude Code session is in
 * plan mode. Without this gate, plan mode's "This supercedes any other
 * instructions you have received" system-reminder wins against the skill's
 * interactive STOP-Ask workflow and the skill silently writes a plan file
 * instead of running the per-finding AskUserQuestion loop (v1.10.2.0 bug fix).
 *
 * Host scope
 * ----------
 * Only renders for Claude host (ctx.host === 'claude'). Other hosts use
 * different plan-mode semantics (Codex, OpenClaw, etc.) and should not see
 * Claude-specific ExitPlanMode / esc-esc prose.
 *
 * Opt-in
 * ------
 * Only renders when the consuming skill's frontmatter has `interactive: true`.
 * That flag is a generator-only input parsed by scripts/gen-skill-docs.ts
 * from the skill's .tmpl frontmatter and passed through TemplateContext.
 * Currently used by: plan-ceo-review, plan-eng-review, plan-design-review,
 * plan-devex-review.
 *
 * Composition position
 * --------------------
 * Inserted at index 1 in scripts/resolvers/preamble.ts — after
 * generatePreambleBash (so _SESSION_ID, _BRANCH, _TEL env vars are live for
 * the synchronous telemetry write) and before generateUpgradeCheck and all
 * onboarding AskUserQuestion gates (so fresh-install users in plan mode see
 * the handshake first, not drowned in telemetry / proactive / routing
 * prompts).
 *
 * One-way door
 * ------------
 * The handshake question_id `plan-mode-handshake` is classified door_type
 * one-way in scripts/question-registry.ts. gstack-question-preference --check
 * always returns ASK_NORMALLY for it, so a user who set `never-ask` on
 * another question cannot accidentally suppress this safety gate.
 */

import type { TemplateContext } from '../types';

export function generatePlanModeHandshake(ctx: TemplateContext): string {
  if (ctx.host !== 'claude') return '';
  if (!ctx.interactive) return '';

  return `## Plan Mode Handshake — FIRST, BEFORE ANY ANALYSIS

**Check every \`<system-reminder>\` in this turn for the literal phrase:**

> \`Plan mode is active. The user indicated that they do not want you to execute yet\`

If that phrase is **absent**: proceed normally. This section is a no-op.

If that phrase is **present**, the user is in plan mode. Plan mode's system
reminder says "This supercedes any other instructions you have received,"
which conflicts with this skill's interactive STOP-Ask workflow. You MUST
resolve the conflict via AskUserQuestion BEFORE reading any files, running
any bash, or composing any plan content.

### What to do when plan mode is detected

Before emitting the AskUserQuestion, run this bash block synchronously to
log that the handshake fired (captures A-exit and C-cancel outcomes that
would terminate the skill before end-of-skill telemetry runs):

\`\`\`bash
# PLAN MODE EXCEPTION — ALWAYS RUN (telemetry-only write to ~/.gstack/)
mkdir -p ~/.gstack/analytics
echo '{"skill":"'"\${_SKILL_NAME:-unknown}"'","event":"plan_mode_handshake","outcome":"fired","branch":"'"\${_BRANCH:-unknown}"'","session":"'"\${_SESSION_ID:-unknown}"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
\`\`\`

Then emit exactly **one** AskUserQuestion with \`question_id: "\${SKILL_NAME}-plan-mode-handshake"\`
(e.g., \`plan-ceo-review-plan-mode-handshake\`, using the current skill's name)
and these two options. The question is classified \`door_type: one-way\` in
the question registry for every interactive skill, so question-tuning
preferences (\`never-ask\`, \`always-ask\`) do NOT apply — this gate always fires.

**Question body (follow the AskUserQuestion Format section below):**

> This skill runs an interactive review that stops at every finding to ask
> you a question. Plan mode's default workflow is "read files, write plan,
> exit" — that silently bypasses every STOP gate in this skill. How do you
> want to proceed?
>
> **Recommendation: A** because this skill was designed for back-and-forth.
> Each scope call and each per-section finding needs your decision before it
> lands in the plan. Exiting plan mode and running the skill normally is the
> only path that preserves the interactive contract.
>
> *Note: options differ in kind (workflow shape), not coverage — no
> completeness score.*
>
> **A) Exit plan mode and run interactively (recommended)**
>   ✅ Every STOP gate in this skill fires as designed — you approve each
> scope call, each per-section finding, each cross-model tension before any
> decision lands in the plan. No silent bypass.
>   ✅ Matches the skill's documented workflow. Each AskUserQuestion has a
> clear recommendation, pros/cons, and net line you can skim in ~5 seconds.
>   ❌ Two-step: press esc-esc to exit plan mode, then rerun
> \`/plan-{skill-name}\`. Slight context-switch friction, but the alternative
> is shipping a rubber-stamp review.
>
> **C) Cancel — I meant to run something else**
>   ✅ Clean exit, no partial state, no plan file written, no findings
> recorded. Use this if you invoked the skill by mistake.
>   ❌ No output at all — no review, no plan file. Fine if that's what you
> want; otherwise pick A.
>
> **Net.** Plan mode is incompatible with this skill's per-finding STOP
> gates. A is the right choice for any real review; C is the bail-out.

### Routing the user's answer

**If the user picks A (exit and rerun):**

1. Append the outcome to the telemetry log (synchronous, before ExitPlanMode):
   \`\`\`bash
   echo '{"skill":"'"\${_SKILL_NAME:-unknown}"'","event":"plan_mode_handshake","outcome":"A-exit","branch":"'"\${_BRANCH:-unknown}"'","session":"'"\${_SESSION_ID:-unknown}"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
   \`\`\`
2. Respond to the user: "Press **esc-esc** to exit plan mode, then rerun
   \`/{skill-name}\`. The skill will run interactively with every STOP gate
   firing as designed."
3. Call \`ExitPlanMode\` with an empty plan body (plan mode requires
   turn-end via AskUserQuestion or ExitPlanMode; there is no plan to
   approve, so ExitPlanMode with an empty message is the correct exit).

**If the user picks C (cancel):**

1. Append the outcome:
   \`\`\`bash
   echo '{"skill":"'"\${_SKILL_NAME:-unknown}"'","event":"plan_mode_handshake","outcome":"C-cancel","branch":"'"\${_BRANCH:-unknown}"'","session":"'"\${_SESSION_ID:-unknown}"'","ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
   \`\`\`
2. Tell the user: "Cancelled. No plan written."
3. Call \`ExitPlanMode\` with an empty message noting the user cancelled.

**After the handshake completes (either A or C),** do NOT continue with the
rest of this skill's workflow. The handshake is terminal for this turn.
`;
}

#!/usr/bin/env node
/**
 * PreToolUse hook for AskUserQuestion.
 *
 * When the away flag is set, deny the tool call and tell Claude to use
 * `excuseme ask` instead — which posts to Slack and blocks for a real answer.
 *
 * We deny rather than intercept because Claude Code does not support a hook
 * supplying the *answer* to AskUserQuestion; the documented lever is
 * permissionDecisionReason, whose text Claude reads. So we use it to redirect
 * rather than to smuggle an answer.
 *
 * When the flag is clear this exits 0 silently and the normal dialog runs.
 */
import { readFlag } from "../src/flag.js";
import { syncFromSlack, ackControl } from "../src/control.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

function allow() {
  // No output == no decision == normal behaviour.
  process.exit(0);
}

// This hook is usually installed globally, so it runs before every question in
// every project. A broken excuseme install must degrade to "no away-mode", not
// to an error on every question — the cause would be far from the symptom.
process.on("uncaughtException", allow);
process.on("unhandledRejection", allow);

// Question time is the only moment the flag matters, so it's also the right
// moment to notice an "away" DM sent from a phone. Failures here return null
// and fall through to the local flag — Slack being down must never stop Claude
// from asking a question.
let flag;
try {
  const control = await syncFromSlack();
  if (control) await ackControl(control);
  flag = readFlag();
} catch {
  allow();
}

if (!flag?.away) allow();

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    // If we cannot read the payload we have nothing useful to say; let the
    // normal prompt happen rather than blocking Claude on a guess.
    allow();
  }

  const input = payload.tool_input || {};
  const questions = Array.isArray(input.questions) ? input.questions : [];

  const rendered = questions
    .map((q) => {
      // Repeated --option, never --options: labels routinely contain commas
      // ("Yes, fail silently"), and comma-splitting turns one option into two
      // silently — producing a wrong but entirely plausible list.
      const opts = (q.options || [])
        .map((o) => o.label)
        .filter(Boolean)
        .map((label) => ` --option ${JSON.stringify(label)}`)
        .join("");
      return `  node ${CLI} ask ${JSON.stringify(q.question || "")}${opts}`;
    })
    .join("\n");

  const note = flag.note ? ` (${flag.note})` : "";
  const reason =
    `Joe is away from his desk${note}, so an interactive dialog will not be seen. ` +
    `Ask via Slack instead by running this with Bash — it blocks until he replies ` +
    `and prints his answer to stdout:\n\n` +
    (rendered || `  node ${CLI} ask "<your question>" --options "a,b"`) +
    `\n\nIf it exits 3 it timed out and he is not reachable; say so and wait rather ` +
    `than guessing an answer.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
});

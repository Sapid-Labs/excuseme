import { requireSlackConfig } from "./config.js";
import { postQuestion, fetchReplies, fetchChannelReplies, postAck } from "./slack.js";
import { register, deregister, isOnlyOutstanding } from "./outstanding.js";
import { parseControl } from "./control.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Slack errors that will never fix themselves. Retrying these just burns the
 * whole timeout while looking like nobody replied — which is exactly how a
 * wrong-content-type bug once masqueraded as "Joe is ignoring me".
 */
const FATAL = [
  "invalid_arguments",
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "channel_not_found",
  "thread_not_found",
  "not_in_channel",
];

const isFatal = (message) => FATAL.some((code) => message.includes(code));

/**
 * Resolve a raw Slack reply into an answer.
 *
 * A bare number picks that option. Anything else is taken literally — if Joe
 * types a real sentence we must not mangle it into an option index, since the
 * whole point is that he can say something we did not anticipate.
 */
export function resolveReply(text, options, { multi = false } = {}) {
  const trimmed = text.trim();

  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= options.length;

  if (options.length) {
    const asNumber = Number(trimmed);
    if (inRange(asNumber)) {
      return { answer: options[asNumber - 1], viaOption: [asNumber] };
    }

    // Multi-select: "1,3" / "1 3" / "1 and 3". Only when the whole message is
    // numbers — "2 but only for dev" must stay literal.
    if (multi && /^[\d\s,and]+$/i.test(trimmed)) {
      const picked = trimmed
        .split(/[\s,]+|\band\b/i)
        .map((s) => s.trim())
        // Adjacent separators ("1 and 3") yield empty strings, and Number("")
        // is 0 — which would fail the range check and drop the whole reply.
        .filter(Boolean)
        .map(Number)
        .filter((n) => !Number.isNaN(n));
      if (picked.length && picked.every(inRange)) {
        const unique = [...new Set(picked)];
        return {
          answer: unique.map((n) => options[n - 1]).join(", "),
          viaOption: unique,
        };
      }
    }
  }

  return { answer: trimmed, viaOption: null };
}

/**
 * Post a question to Slack and block until an answer arrives.
 * Returns null on timeout — the caller decides what that means. We never
 * invent an answer, because a guessed answer is indistinguishable from a real
 * one once it is in the transcript.
 */
export async function ask({ question, options = [], context, project, session, multi = false }) {
  const config = requireSlackConfig();
  const threadTs = await postQuestion(config, {
    question,
    options,
    context,
    project,
    session,
    multi,
  });

  register(threadTs, { question, project, session });

  try {
    const deadline = Date.now() + config.timeoutMs;

    while (Date.now() < deadline) {
      await sleep(config.pollMs);

      let reply = null;
      try {
        const threaded = await fetchReplies(config, threadTs);
        if (threaded.length) {
          reply = threaded[0].text;
        } else if (isOnlyOutstanding(threadTs)) {
          // Answered in the channel instead of the thread. Only safe to claim
          // when nothing else is waiting, and never for a control word — "back"
          // is Joe returning to his desk, not an answer to this question.
          const loose = await fetchChannelReplies(config, threadTs);
          const answerish = loose.find((m) => !parseControl(m.text));
          if (answerish) reply = answerish.text;
        }
      } catch (err) {
        // Config/permission errors are terminal — surface them immediately rather
        // than silently retrying until the timeout.
        if (isFatal(err.message)) throw err;
        // A transient Slack blip should not throw away a question Joe may be
        // mid-way through answering. Keep polling until the deadline.
        process.stderr.write(`excuseme: poll failed (${err.message}), retrying\n`);
        continue;
      }

      if (reply !== null) {
        const { answer, viaOption } = resolveReply(reply, options, { multi });
        await postAck(
          config,
          threadTs,
          viaOption ? `Got it — *${answer}*` : "Got it, passing that back.",
        ).catch(() => {}); // ack is a nicety; never fail the answer over it
        return { answer, viaOption, threadTs };
      }
    }

    return null;
  } finally {
    deregister(threadTs);
  }
}

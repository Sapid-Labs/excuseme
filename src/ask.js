import { requireSlackConfig } from "./config.js";
import { postQuestion, fetchReplies, postAck } from "./slack.js";

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
export function resolveReply(text, options) {
  const trimmed = text.trim();
  const asNumber = Number(trimmed);

  if (
    options.length &&
    Number.isInteger(asNumber) &&
    asNumber >= 1 &&
    asNumber <= options.length
  ) {
    return { answer: options[asNumber - 1], viaOption: asNumber };
  }

  return { answer: trimmed, viaOption: null };
}

/**
 * Post a question to Slack and block until an answer arrives.
 * Returns null on timeout — the caller decides what that means. We never
 * invent an answer, because a guessed answer is indistinguishable from a real
 * one once it is in the transcript.
 */
export async function ask({ question, options = [], context }) {
  const config = requireSlackConfig();
  const threadTs = await postQuestion(config, { question, options, context });

  const deadline = Date.now() + config.timeoutMs;

  while (Date.now() < deadline) {
    await sleep(config.pollMs);

    let replies;
    try {
      replies = await fetchReplies(config, threadTs);
    } catch (err) {
      // Config/permission errors are terminal — surface them immediately rather
      // than silently retrying until the timeout.
      if (isFatal(err.message)) throw err;
      // A transient Slack blip should not throw away a question Joe may be
      // mid-way through answering. Keep polling until the deadline.
      process.stderr.write(`excuseme: poll failed (${err.message}), retrying\n`);
      continue;
    }

    if (replies.length) {
      const { answer, viaOption } = resolveReply(replies[0].text, options);
      await postAck(
        config,
        threadTs,
        viaOption ? `Got it — *${answer}*` : "Got it, passing that back.",
      ).catch(() => {}); // ack is a nicety; never fail the answer over it
      return { answer, viaOption, threadTs };
    }
  }

  return null;
}

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { setAway, clearAway } from "./flag.js";
import { writeJsonAtomic } from "./outstanding.js";

const STATE_PATH = join(homedir(), ".claude", "excuseme-state.json");

/**
 * Control messages let Joe toggle the flag from his phone by DMing the bot,
 * which is the same UX a slash command would give without needing a public
 * Request URL, a hosted endpoint, or a cloud datastore for the flag.
 *
 * The local flag file stays the single source of truth. A Slack message is a
 * *command* that gets applied to it, not a second place to look.
 */

const AWAY_WORDS = ["away", "afk", "brb", "out", "stepping out"];
const BACK_WORDS = ["back", "here", "returned", "im back", "i'm back"];

/**
 * Parse a control message. Returns null when the text isn't a command — most
 * DM traffic is answers to questions, and misreading an answer as a command
 * would be worse than ignoring a command.
 */
export function parseControl(raw) {
  const text = raw.trim().toLowerCase().replace(/[.!]+$/, "");

  if (BACK_WORDS.includes(text)) return { kind: "back" };

  const awayWord = AWAY_WORDS.find((w) => text === w || text.startsWith(w + " "));
  if (!awayWord) return null;

  const rest = text.slice(awayWord.length).trim();
  if (!rest) return { kind: "away" };

  // "away 90" / "away 90m" / "away 2h"
  const dur = rest.match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)?$/);
  if (dur) {
    const n = Number(dur[1]);
    const isHours = /^h/.test(dur[2] || "");
    return { kind: "away", minutes: isHours ? n * 60 : n };
  }

  // "away until 3pm" / "away until 15:30"
  const until = rest.match(/^until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (until) {
    let hour = Number(until[1]);
    const minute = Number(until[2] || 0);
    const meridiem = until[3];
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    const target = new Date();
    target.setHours(hour, minute, 0, 0);
    // A time already past means tomorrow — "away until 9am" sent at 11pm.
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);

    return { kind: "away", minutes: Math.round((target - Date.now()) / 60_000) };
  }

  // "away school run" — treat the remainder as a note.
  return { kind: "away", note: rest };
}

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  // Atomic: two hooks can fire simultaneously in different sessions, and a
  // torn write would leave the cursor unparseable (silently reprocessing every
  // control message from scratch).
  writeJsonAtomic(STATE_PATH, state);
}

/**
 * Apply any control messages sent since we last looked.
 *
 * Never throws: this runs inside a PreToolUse hook, and a Slack outage must not
 * be able to block Claude from asking a question.
 */
export async function syncFromSlack({ verbose = false } = {}) {
  const config = loadConfig();
  if (!config.token || !config.channel) return null;

  const state = readState();
  const params = new URLSearchParams({ channel: config.channel, limit: "20" });
  if (state.lastTs) params.set("oldest", state.lastTs);

  let messages;
  try {
    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      // The hook is in the critical path of every question; never hang on it.
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    if (!json.ok) {
      if (verbose) process.stderr.write(`excuseme: sync failed (${json.error})\n`);
      return null;
    }
    messages = json.messages || [];
  } catch (err) {
    if (verbose) process.stderr.write(`excuseme: sync failed (${err.message})\n`);
    return null;
  }

  // Slack returns newest-first; walk oldest-first so the latest command wins.
  const fromJoe = messages
    .filter((m) => !m.bot_id && m.subtype !== "bot_message" && typeof m.text === "string")
    .reverse();

  if (!fromJoe.length) return null;

  let applied = null;
  for (const msg of fromJoe) {
    if (msg.ts === state.lastTs) continue; // `oldest` is inclusive
    const cmd = parseControl(msg.text);
    if (cmd) applied = cmd;
  }

  writeState({ ...state, lastTs: fromJoe[fromJoe.length - 1].ts });

  if (!applied) return null;

  if (applied.kind === "back") {
    clearAway();
    return { kind: "back" };
  }

  const flag = setAway({ minutes: applied.minutes, note: applied.note });
  return { kind: "away", flag };
}

export async function ackControl(result) {
  const config = loadConfig();
  if (!config.token || !config.channel || !result) return;

  const text =
    result.kind === "back"
      ? "Welcome back — I'll ask in the terminal from now on."
      : `Away noted${result.flag.note ? ` (${result.flag.note})` : ""}. ` +
        (result.flag.until
          ? `Clearing at ${new Date(result.flag.until).toLocaleTimeString()}.`
          : "No expiry set.");

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: config.channel, text }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

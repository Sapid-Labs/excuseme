import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".config", "excuseme", "config.json");
export const FLAG_PATH = join(homedir(), ".claude", "excuseme-away.json");

/**
 * Config lives outside the repo so the bot token never lands in git.
 * Env vars win, so a shell can override without touching the file.
 *
 * {
 *   "token":   "xoxb-...",   // bot token, chat:write + im:history
 *   "channel": "D0123ABCD",  // DM channel id to talk to Joe in
 *   "pollMs":  3000,
 *   "timeoutMs": 600000
 * }
 */
export function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`${CONFIG_PATH} is not valid JSON: ${err.message}`);
    }
  }

  const token = process.env.EXCUSEME_SLACK_TOKEN || file.token;
  const channel = process.env.EXCUSEME_SLACK_CHANNEL || file.channel;

  return {
    token,
    channel,
    // Slack rate limits conversations.history to ~50/min; 3s keeps us well under
    // even with a couple of concurrent sessions asking at once.
    pollMs: Number(process.env.EXCUSEME_POLL_MS || file.pollMs || 3000),
    // Matches the Claude Code command-hook ceiling. Going higher just means the
    // harness kills us mid-wait instead of us exiting cleanly.
    timeoutMs: Number(process.env.EXCUSEME_TIMEOUT_MS || file.timeoutMs || 600_000),
  };
}

export function requireSlackConfig() {
  const config = loadConfig();
  const missing = [];
  if (!config.token) missing.push("token (or EXCUSEME_SLACK_TOKEN)");
  if (!config.channel) missing.push("channel (or EXCUSEME_SLACK_CHANNEL)");
  if (missing.length) {
    throw new Error(
      `Slack is not configured. Missing: ${missing.join(", ")}.\n` +
        `Run \`excuseme setup\` for instructions, then write ${CONFIG_PATH}.`,
    );
  }
  return config;
}

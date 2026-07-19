import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { FLAG_PATH } from "./config.js";

/**
 * The away flag. Presence of the file means "away", but an `until` timestamp
 * lets it expire on its own — a flag you forget to clear is worse than no flag,
 * because every later session silently waits on Slack for a person who is
 * sitting right there.
 */
export function readFlag() {
  if (!existsSync(FLAG_PATH)) return { away: false };

  let data;
  try {
    data = JSON.parse(readFileSync(FLAG_PATH, "utf8"));
  } catch {
    // A corrupt flag file should not strand a session waiting on Slack.
    return { away: false, corrupt: true };
  }

  if (data.until) {
    const until = Date.parse(data.until);
    if (Number.isFinite(until) && Date.now() > until) {
      return { away: false, expired: true, until: data.until, since: data.since };
    }
  }

  return { away: true, since: data.since, until: data.until, note: data.note };
}

/**
 * Away, expiring at end of day unless told otherwise.
 *
 * Joe's call: no-expiry is never the default. A flag left set overnight makes
 * every session the next morning wait on Slack for someone sitting at the desk,
 * and that failure is silent. `--forever` is still available, but you have to
 * ask for it.
 */
export function setAway({ minutes, forever, note } = {}) {
  mkdirSync(dirname(FLAG_PATH), { recursive: true });
  const now = new Date();
  const flag = { since: now.toISOString() };

  if (!forever) {
    let until;
    if (minutes) {
      until = new Date(now.getTime() + minutes * 60_000);
    } else {
      until = new Date(now);
      until.setHours(23, 59, 59, 999);
    }
    flag.until = until.toISOString();
  }

  if (note) flag.note = note;
  writeFileSync(FLAG_PATH, JSON.stringify(flag, null, 2) + "\n");
  return flag;
}

export function clearAway() {
  if (!existsSync(FLAG_PATH)) return false;
  rmSync(FLAG_PATH);
  return true;
}

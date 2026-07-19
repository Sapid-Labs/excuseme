import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const PATH = join(homedir(), ".claude", "excuseme-outstanding.json");

/**
 * Registry of questions currently waiting on an answer.
 *
 * Exists so a plain channel reply can be matched to a question: if exactly one
 * question is outstanding there's no ambiguity, and answering in the channel
 * instead of the thread is an easy slip to make on mobile.
 */

/** Atomic: write a temp file and rename, so a concurrent reader never sees a partial file. */
export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

function read() {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Drop entries whose process died — a killed `ask` would otherwise linger forever. */
function prune(entries) {
  const live = {};
  for (const [ts, entry] of Object.entries(entries)) {
    try {
      process.kill(entry.pid, 0); // signal 0 tests existence without sending
      live[ts] = entry;
    } catch {
      // process is gone; drop it
    }
  }
  return live;
}

export function register(threadTs, { question, project, session }) {
  const entries = prune(read());
  entries[threadTs] = { pid: process.pid, question, project, session, at: new Date().toISOString() };
  writeJsonAtomic(PATH, entries);
}

export function deregister(threadTs) {
  const entries = prune(read());
  delete entries[threadTs];
  writeJsonAtomic(PATH, entries);
}

export function list() {
  return prune(read());
}

/** True when this question is the only one waiting, so a stray reply is unambiguous. */
export function isOnlyOutstanding(threadTs) {
  const keys = Object.keys(list());
  return keys.length === 1 && keys[0] === threadTs;
}

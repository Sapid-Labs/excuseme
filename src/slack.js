const API = "https://slack.com/api";

/** Write methods take a JSON body. */
async function post(token, method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return check(method, await res.json());
}

/**
 * Read methods reject a JSON body with `invalid_arguments` — they want GET with
 * query params. Sending JSON to conversations.replies fails in a way that looks
 * like a scopes or channel problem but is neither.
 */
async function get(token, method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}/${method}?${qs}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  return check(method, await res.json());
}

function check(method, json) {
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
  return json;
}

/**
 * Post the question and return the thread ts to watch.
 *
 * Deliberately plain text rather than Block Kit buttons: a button click posts
 * to the app's interactivity Request URL, which would mean a public HTTPS
 * endpoint and an always-on listener. Numbered options + a threaded reply gets
 * the same answer with no server at all.
 */
export async function postQuestion(config, { question, options, context }) {
  const lines = [`*${question}*`];

  if (options.length) {
    lines.push("");
    options.forEach((opt, i) => lines.push(`  *${i + 1}.*  ${opt}`));
    lines.push("");
    lines.push("_Reply in thread with a number, or type your own answer._");
  } else {
    lines.push("");
    lines.push("_Reply in thread._");
  }

  if (context) lines.push(`\n\`${context}\``);

  const res = await post(config.token, "chat.postMessage", {
    channel: config.channel,
    text: `Claude needs input: ${question}`, // notification fallback
    mrkdwn: true,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    ],
  });

  return res.ts;
}

/** Fetch replies in the thread, excluding our own question message. */
export async function fetchReplies(config, threadTs) {
  const res = await get(config.token, "conversations.replies", {
    channel: config.channel,
    ts: threadTs,
    limit: "20",
  });

  return (res.messages || [])
    .filter((m) => m.ts !== threadTs)
    .filter((m) => !m.bot_id && m.subtype !== "bot_message")
    .filter((m) => typeof m.text === "string" && m.text.trim().length > 0);
}

export async function postAck(config, threadTs, text) {
  await post(config.token, "chat.postMessage", {
    channel: config.channel,
    thread_ts: threadTs,
    text,
  });
}

/** Confirms the token works and resolves who we are. Used by `excuseme doctor`. */
export async function authTest(token) {
  return post(token, "auth.test", {});
}

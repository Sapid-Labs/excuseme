# excuseme

Claude Code stops dead when it needs a decision. If you've stepped away, it sits on a dialog nobody is there to see.

`excuseme` relays those questions to Slack and brings your answer back into the session — so you can answer from your phone and the work keeps moving.

```
Claude: needs a decision
   ↓  (away flag is set)
Slack DM: "Which database? 1. Postgres  2. SQLite  3. Neon"
   ↓  you reply "3" from your phone
Claude: continues with "Neon"
```

No server. No public URL. No always-on process. Just a CLI and a hook.

---

## Install

**Requires Node 22+** (uses native `fetch`).

```bash
git clone https://github.com/SapidLabs/excuseme.git
cd excuseme
node src/cli.js setup     # prints Slack app instructions
```

### 1. Create the Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**, pick your workspace, and paste [`app-manifest.json`](./app-manifest.json). That pre-sets the scopes *and* the App Home setting that lets you reply to the bot — which is easy to miss when clicking through manually.

Then **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`).

### 2. Get your DM channel id

In Slack, open the `excuseme` app under **Apps** and send it any message. Click the app name → **About** → the id starting with `D` is at the bottom.

### 3. Write the config

`~/.config/excuseme/config.json`, outside the repo so the token never lands in git:

```json
{ "token": "xoxb-...", "channel": "D0123ABCD" }
```

```bash
chmod 600 ~/.config/excuseme/config.json
node src/cli.js doctor      # verifies token, channel, and auth
```

### 4. Wire up the hook

In `~/.claude/settings.json` (global) or `.claude/settings.json` (per project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/excuseme/hooks/ask-user-question-redirect.js",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

---

## Usage

```bash
excuseme on                      # away, auto-clears at end of day
excuseme on --for 90             # away for 90 minutes
excuseme on --forever            # no expiry (you must run `off`)
excuseme off
excuseme status
```

Or **DM the bot from your phone** — no terminal needed:

```
away              away 90           away 2h
away until 3pm    away school run   back
```

Control DMs are applied the next time Claude asks something, which is the only moment the flag matters.

To ask manually:

```bash
excuseme ask "Deploy to prod?" --option "Yes" --option "No, hold"
```

`ask` exits `0` with the answer on stdout, `3` on timeout, `4` if unconfigured.

---

## Design notes

Three things that look like obvious improvements but don't work. All were tried.

**You can't intercept `AskUserQuestion` and supply the answer.** Claude Code has no supported way for a hook to return a tool result. The documented lever is `permissionDecisionReason`, which is text Claude *reads*. So the hook doesn't fight the harness — it denies the call with a reason that redirects Claude to `excuseme ask`, an ordinary CLI whose stdout is an ordinary tool result. The `tool_input` schema for `AskUserQuestion` is also undocumented, so the hook degrades gracefully if it can't parse the payload.

**Block Kit buttons don't work without a server.** A button click POSTs to the app's interactivity Request URL — a public HTTPS endpoint and an always-on listener. Buttons would render and then silently do nothing. Numbered options plus a threaded reply need none of that.

**Slash commands would need hosting too.** Same Request URL problem, plus a second one: a slash command hits *Slack's* servers, which can't write a file on your laptop. You'd need the flag in a cloud KV and a network read on every hook. DMing the bot `away` gets the same UX with zero infrastructure.

Smaller decisions:

- **The flag auto-expires at end of day.** A flag left set overnight makes every session the next morning wait on Slack for someone sitting right at the desk — and that failure is silent. `--forever` exists, but you have to ask for it.
- **A corrupt flag file is treated as "here."** Same reasoning: fail toward the mode where you notice.
- **Fatal Slack errors abort immediately** instead of retrying. During development a content-type bug spent a full 10-minute timeout looking exactly like "nobody replied."
- **Slack read methods need GET with query params.** `conversations.history` and `conversations.replies` reject a JSON body with `invalid_arguments` — which looks like a scopes or channel problem and is neither. Write methods like `chat.postMessage` take JSON. This is the single most likely thing to break a fork of this code.
- **Bare in-range numbers pick an option; anything else passes through verbatim.** You can say something the options didn't anticipate. Control words are matched strictly, so answering `"2"` or `"yes"` can never toggle your flag by accident.
- **On timeout, nothing is printed to stdout.** It never invents an answer — a guessed answer is indistinguishable from a real one once it's in the transcript.

## License

MIT

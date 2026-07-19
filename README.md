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
            "command": "H=/absolute/path/to/excuseme/hooks/ask-user-question-redirect.js; command -v node >/dev/null 2>&1 && [ -f \"$H\" ] && node \"$H\"; exit 0",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

The guard matters if you install this globally, because then it runs before every
question in every project. If the repo moves or Node isn't on PATH, an unguarded
hook errors on every question — and the cause is nowhere near the symptom. With
the guard, a broken install just means away-mode stops working. The hook also
traps its own exceptions and exits 0, so a bad config file fails the same way.

---

## Troubleshooting

**"Sending messages to this app has been turned off"**

The App Home messages tab is read-only. If you used `app-manifest.json` this is
already correct; if you built the app from scratch, go to your app → **App Home**
→ **Show Tabs** → enable **Messages Tab** and check **"Allow users to send Slash
commands and messages from the messages tab."**

Then — and this is the part that wastes an afternoon — **each Slack client caches
that setting separately.** Desktop picks it up after `Cmd+R`. Mobile does not:
force-quitting isn't enough, and you have to **sign out and back in on mobile**
before it will let you send. Since answering from your phone is the entire point,
verify on mobile specifically before assuming setup is done.

**Every poll fails with `invalid_arguments`**

You're sending a JSON body to a read method. Slack's read endpoints
(`conversations.history`, `conversations.replies`) require GET with query params;
only write endpoints take JSON. This looks like a scopes or channel problem and
is neither.

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
excuseme ask "Which fixes?" --option A --option B --option C --multi   # reply "1,3"
```

`ask` exits `0` with the answer on stdout, `3` on timeout, `4` if unconfigured.

Reply with a number to pick an option, `1,3` for multi-select, or type anything
else to answer in your own words. Free text is passed through verbatim, so
`"3, but branch per PR"` reaches the model exactly as written — the number and
the caveat both.

**Put your whole answer in one message.** Only the first reply is read; sending
`2` and then `but only for dev` separately drops the second half silently.

You can reply **in the thread or in the main DM** — a loose channel message is
matched to the question when only one is waiting. With two or more questions in
flight the fallback switches off (a stray message would be ambiguous), so reply
in-thread. Each question is labelled `project · session` to tell them apart.

### VS Code tasks

Toggling from the editor is often quicker than switching to a terminal. Add this
to your **user-level** `tasks.json` (Cmd+Shift+P → *Tasks: Open User Tasks*) so
it's available in every project, then run them with Cmd+Shift+P → *Run Task*.

Replace `/absolute/path/to/excuseme` with wherever you cloned it.

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Away",
            "icon": { "id": "bell-slash", "color": "terminal.ansiYellow" },
            "type": "shell",
            "command": "node /absolute/path/to/excuseme/src/cli.js on",
            "problemMatcher": [],
            "presentation": { "reveal": "always", "panel": "shared", "clear": true, "close": true }
        },
        {
            "label": "Away for…",
            "icon": { "id": "watch", "color": "terminal.ansiYellow" },
            "type": "shell",
            "command": "node /absolute/path/to/excuseme/src/cli.js on --for ${input:awayMinutes}",
            "problemMatcher": [],
            "presentation": { "reveal": "always", "panel": "shared", "clear": true, "close": true }
        },
        {
            "label": "Back",
            "icon": { "id": "check", "color": "terminal.ansiGreen" },
            "type": "shell",
            "command": "node /absolute/path/to/excuseme/src/cli.js off",
            "problemMatcher": [],
            "presentation": { "reveal": "always", "panel": "shared", "clear": true, "close": true }
        },
        {
            "label": "Away status",
            "icon": { "id": "info", "color": "terminal.ansiBlue" },
            "type": "shell",
            "command": "node /absolute/path/to/excuseme/src/cli.js status",
            "problemMatcher": [],
            "presentation": { "reveal": "always", "panel": "shared", "clear": true }
        }
    ],
    "inputs": [
        {
            "id": "awayMinutes",
            "type": "promptString",
            "description": "Minutes away",
            "default": "60"
        }
    ]
}
```

The toggles set `"close": true` so the panel dismisses itself after the one-line
confirmation — flipping a flag shouldn't leave a terminal open. `Away status`
omits it, since its output is the point.

---

## Design notes

Three things that look like obvious improvements but don't work. All were tried.

**You can't intercept `AskUserQuestion` and supply the answer.** Claude Code has no supported way for a hook to return a tool result. The documented lever is `permissionDecisionReason`, which is text Claude *reads*. So the hook doesn't fight the harness — it denies the call with a reason that redirects Claude to `excuseme ask`, an ordinary CLI whose stdout is an ordinary tool result. The `tool_input` schema for `AskUserQuestion` is also undocumented, so the hook degrades gracefully if it can't parse the payload.

**Block Kit buttons don't work without a server.** A button click POSTs to the app's interactivity Request URL — a public HTTPS endpoint and an always-on listener. Buttons would render and then silently do nothing. Numbered options plus a threaded reply need none of that.

**Slash commands would need hosting too.** Same Request URL problem, plus a second one: a slash command hits *Slack's* servers, which can't write a file on your laptop. You'd need the flag in a cloud KV and a network read on every hook. DMing the bot `away` gets the same UX with zero infrastructure.

### Concurrent sessions

Nothing polls in the background. Slack is touched in exactly two places: while an
`ask` is blocking (every 3s on its own thread) and once per `AskUserQuestion` to
check for `away`/`back` DMs. Idle cost is zero.

Each question is its own Slack thread, so two sessions asking at once can't get
each other's answers. Messages are labelled `project · session` so you can tell
which is which.

Because `conversations.replies` only sees *threaded* replies, answering in the
main DM would otherwise time out silently — an easy slip on mobile. So a loose
channel message is accepted as the answer **when exactly one question is
outstanding**, tracked in `~/.claude/excuseme-outstanding.json`. Control words
(`away`, `back`) are never consumed as answers, and dead PIDs are pruned so a
killed `ask` can't block the fallback forever.

Smaller decisions:

- **The flag auto-expires at end of day.** A flag left set overnight makes every session the next morning wait on Slack for someone sitting right at the desk — and that failure is silent. `--forever` exists, but you have to ask for it.
- **A corrupt flag file is treated as "here."** Same reasoning: fail toward the mode where you notice.
- **Fatal Slack errors abort immediately** instead of retrying. During development a content-type bug spent a full 10-minute timeout looking exactly like "nobody replied."
- **Slack read methods need GET with query params.** `conversations.history` and `conversations.replies` reject a JSON body with `invalid_arguments` — which looks like a scopes or channel problem and is neither. Write methods like `chat.postMessage` take JSON. This is the single most likely thing to break a fork of this code.
- **Bare in-range numbers pick an option; anything else passes through verbatim.** You can say something the options didn't anticipate. Control words are matched strictly, so answering `"2"` or `"yes"` can never toggle your flag by accident.
- **On timeout, nothing is printed to stdout.** It never invents an answer — a guessed answer is indistinguishable from a real one once it's in the transcript.

## License

MIT

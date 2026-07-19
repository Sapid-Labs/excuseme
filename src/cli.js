#!/usr/bin/env node
import { basename } from "node:path";
import { readFlag, setAway, clearAway } from "./flag.js";
import { ask } from "./ask.js";
import { loadConfig, requireSlackConfig, CONFIG_PATH, FLAG_PATH } from "./config.js";
import { authTest } from "./slack.js";
import { syncFromSlack, ackControl } from "./control.js";

const USAGE = `excuseme — relay Claude's questions to Slack while you're away

  excuseme on [--for 90] [--forever] [--note "school run"]
      Mark yourself away. Expires at end of day unless --for or --forever.
  excuseme off                                   mark yourself back
  excuseme status                                is the flag set?
  excuseme sync                                  apply control DMs now

  Or DM the bot from your phone:
      away | away 90 | away 2h | away until 3pm | away school run | back

  excuseme ask "<question>" [--option A --option B] [--context "<where from>"]
      --option is repeatable and safe for labels containing commas.
      --options "a,b,c" is the shorthand, but splits on every comma.
      Post a question to Slack, block until you reply, print the answer.
      Exits 0 with the answer on stdout, 3 on timeout, 4 if unconfigured.

  excuseme doctor    check the Slack token and channel work
  excuseme setup     how to create the Slack app
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith("--") ? true : (i++, next);
      // Repeated flags collect into an array so `--option a --option b` works.
      if (key in flags) {
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fmtSince(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h${mins % 60}m ago`;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  switch (cmd) {
    case "on": {
      const minutes = flags.for ? Number(flags.for) : null;
      if (flags.for && !Number.isFinite(minutes)) {
        process.stderr.write(`--for expects minutes, got "${flags.for}"\n`);
        process.exit(1);
      }
      const flag = setAway({
        minutes,
        forever: flags.forever === true,
        note: typeof flags.note === "string" ? flags.note : null,
      });
      process.stdout.write(
        `Away${flag.note ? ` (${flag.note})` : ""}. ` +
          (flag.until
            ? `Auto-clears at ${new Date(flag.until).toLocaleTimeString()}.\n`
            : `No expiry — remember to run \`excuseme off\`.\n`),
      );
      break;
    }

    case "off": {
      process.stdout.write(clearAway() ? "Welcome back.\n" : "Already marked as here.\n");
      break;
    }

    case "sync": {
      const result = await syncFromSlack({ verbose: true });
      if (!result) {
        process.stdout.write("No new control messages.\n");
      } else {
        await ackControl(result);
        process.stdout.write(
          result.kind === "back"
            ? "Applied from Slack: back.\n"
            : `Applied from Slack: away${result.flag.until ? ` until ${new Date(result.flag.until).toLocaleTimeString()}` : ""}.\n`,
        );
      }
      break;
    }

    case "status": {
      await syncFromSlack().then((r) => r && ackControl(r));
      const flag = readFlag();
      if (flag.corrupt) {
        process.stdout.write(`Flag file at ${FLAG_PATH} is corrupt — treating as HERE.\n`);
      } else if (flag.expired) {
        process.stdout.write(`Here (away flag expired at ${flag.until}).\n`);
      } else if (flag.away) {
        process.stdout.write(
          `Away since ${fmtSince(flag.since)}${flag.note ? ` (${flag.note})` : ""}` +
            `${flag.until ? `, clears at ${new Date(flag.until).toLocaleTimeString()}` : ""}.\n`,
        );
      } else {
        process.stdout.write("Here.\n");
      }
      break;
    }

    case "ask": {
      const question = positional[1];
      if (!question) {
        process.stderr.write("excuseme ask needs a question.\n");
        process.exit(1);
      }
      // `--option` is repeatable and the safe form: labels may contain commas.
      // `--options` splits on commas and is only for simple labels — a comma
      // inside a label there silently becomes two options.
      const repeated = flags.option
        ? (Array.isArray(flags.option) ? flags.option : [flags.option]).filter(
            (v) => typeof v === "string",
          )
        : [];
      const commaSplit =
        typeof flags.options === "string"
          ? flags.options.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      const options = repeated.length ? repeated : commaSplit;

      let result;
      try {
        result = await ask({
          question,
          options,
          multi: flags.multi === true,
          // Default the project label to the directory the CLI was run from, so
          // concurrent sessions are distinguishable without extra plumbing.
          project: typeof flags.project === "string" ? flags.project : basename(process.cwd()),
          session: typeof flags.session === "string" ? flags.session.slice(0, 8) : null,
          context: typeof flags.context === "string" ? flags.context : null,
        });
      } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(4);
      }

      if (!result) {
        process.stderr.write(
          "No reply from Slack within the timeout. Ask in the terminal instead.\n",
        );
        process.exit(3);
      }

      // stdout is the answer and nothing else, so a caller can use it directly.
      process.stdout.write(result.answer + "\n");
      break;
    }

    case "doctor": {
      const config = loadConfig();
      process.stdout.write(`config:  ${CONFIG_PATH}\n`);
      process.stdout.write(`flag:    ${FLAG_PATH}\n`);
      process.stdout.write(`token:   ${config.token ? "set" : "MISSING"}\n`);
      process.stdout.write(`channel: ${config.channel || "MISSING"}\n`);
      if (!config.token) process.exit(4);
      try {
        const who = await authTest(config.token);
        process.stdout.write(`auth:    ok — ${who.user} in ${who.team}\n`);
      } catch (err) {
        process.stdout.write(`auth:    FAILED — ${err.message}\n`);
        process.exit(4);
      }
      break;
    }

    case "setup": {
      process.stdout.write(SETUP);
      break;
    }

    default:
      process.stdout.write(USAGE);
      if (cmd) process.exit(1);
  }
}

const SETUP = `Create the Slack app (~5 minutes):

1. https://api.slack.com/apps → Create New App → From an app manifest.
   Pick your workspace, then paste the contents of app-manifest.json
   from this repo.

   Use the manifest rather than clicking through "From scratch": it sets
   the scopes AND messages_tab_read_only_enabled=false, which is what
   lets you reply to the bot at all. That setting is easy to miss and
   fails with "Sending messages to this app has been turned off".

2. Install to Workspace. Copy the Bot User OAuth Token (starts xoxb-).

3. In Slack, find the app under Apps and send it a DM (any message).
   Then get that DM's channel id — open the DM, click the app name,
   the id starting with D is at the bottom of the About tab.

4. Write ${CONFIG_PATH}:

     {
       "token": "xoxb-...",
       "channel": "D0123ABCD"
     }

   chmod 600 it. It is outside the repo so it never lands in git.

5. Verify: excuseme doctor

6. Wire the hook into ~/.claude/settings.json — see the README.
`;

main().catch((err) => {
  process.stderr.write(`excuseme: ${err.stack || err.message}\n`);
  process.exit(1);
});

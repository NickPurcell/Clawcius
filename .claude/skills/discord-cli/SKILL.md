---
name: discord-cli
description: Read, send, search, react to, edit, and delete Discord messages via the local `discord` CLI. Use whenever the task involves Discord — posting a message or update to a channel, checking or summarizing what people said, finding a past message, reacting to something, or cleaning up a message the bot sent.
---

# discord-cli

`discord` operates on **one** pre-configured Discord server. Run it as:

```
/home/npurcell/clawcius/discord-cli/discord <command> [flags]
```

Output is JSON whenever stdout is not a terminal, so piped calls are already
machine-readable. Data goes to stdout; errors and diagnostics go to stderr.

## Start here

Run `discord channels` first in any new task. It returns `{id, name}` for every
channel the bot can see, and confirms auth and configuration in one call. If it
fails, read the `remediation` field in the error — it says what to fix.

## Commands

```
discord channels                                        # list channels (start here)
discord read   -c <channel> [-n 20] [--before <msg-id>] # newest first
discord search -c <channel> [-q text] [--author name] [--since YYYY-MM-DD] [-n 20]
discord send   -c <channel> -t "text"                   # or pipe text on stdin
discord reply  -c <channel> -m <msg-id> -t "text"
discord react  -c <channel> -m <msg-id> -e 🔥           # or :fire: or custom 'name:id'
discord edit   -c <channel> -m <msg-id> -t "text"       # bot's own messages only
discord delete -c <channel> -m <msg-id> --confirm
discord whoami                                          # bot identity + server
```

`-c` accepts a channel **name or ID** — `-c general` works, no lookup needed.

## Rules that will bite you if ignored

**Every message operation needs `-c` as well as `-m`.** Discord's API scopes
message endpoints by channel, so a message ID alone is not enough to address a
message. Carry the channel through from wherever you got the ID.

**`delete` without `--confirm` deletes nothing.** It prints the target message
and exits 4 so you can verify you have the right one, then re-run with
`--confirm`. Never add `--confirm` on the first attempt for a message you have
not already read.

**`search` is bounded, not exhaustive.** Discord's server-side search is
unavailable to bots, so this pages backwards through history and filters
locally, up to `--max-scan` (default 500 messages). Every run prints a coverage
line to stderr:

```
searched 500 message(s); 2 match(es); stopped at the --max-scan limit of 500.
```

If it says "stopped at the --max-scan limit", the result is **not** conclusive.
Either raise `--max-scan` or tell the user the search was capped. Do not report
"there are no messages about X" off a capped scan.

**Do not abbreviate flags.** `--chan` is rejected; write `--channel` or `-c`.

## Exit codes

| Code | Meaning | What to do |
|------|---------|-----------|
| 0 | success | continue |
| 1 | Discord API error | read stderr; often transient, retry once |
| 2 | auth / permission | bot token or bot permissions — needs the user |
| 3 | bad input | fix the arguments; do not retry unchanged |
| 4 | confirmation required | inspect the preview, then re-run with `--confirm` |

## Output shape

Messages are returned slimmed, not as raw Discord objects:

```json
{"id":"124...","author":"Nicky","author_id":"42","content":"deploy is green",
 "ts":"2026-07-24T09:00:00+00:00","reactions":[{"emoji":"🔥","count":2}]}
```

`reply_to`, `attachments`, `edited_ts`, and `is_bot` appear only when relevant.
Pass `--full` for the raw Discord object — it is roughly 3x the tokens, so only
use it when you need a field the slim form omits.

## Common patterns

```bash
# Post a build result
echo "deploy finished: all green" | discord send -c releases

# Summarize recent discussion
discord read -c general -n 50

# Find what someone said about a topic, searching deep
discord search -c general -q "rate limit" --author npurcell --max-scan 2000

# React to the most recent message in a channel
ID=$(discord read -c general -n 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
discord react -c general -m "$ID" -e :eyes:
```

## Not supported yet

File uploads, DMs, threads, pins, and live tailing. Say so plainly rather than
improvising with `curl`.

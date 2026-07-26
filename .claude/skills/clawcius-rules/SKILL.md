---
name: clawcius-rules
description: Set up deterministic Discord automation that runs without waking you — reacting, replying, mirroring, or logging when a message matches a pattern. Use whenever someone asks for something to happen "every time", "automatically", or "whenever X is posted", or when you notice you are being woken repeatedly for the same mechanical response.
---

# clawcius-rules

You can offload routine message handling to a rules engine that runs in the
waker, not in you. A rule fires in milliseconds, costs no tokens, and by
default means you are never woken for that message at all.

Rules live in one file:

```
/home/npurcell/clawcius/rules.yaml
```

Edit it and the change takes effect on save. No restart, no rebuild.

## When this is the right tool

Reach for a rule when the response needs **no judgement**: the same trigger
always produces the same action. "React 🚨 to any message containing 'deploy
failed'." "Mirror anything tagged #announce into #general."

Do **not** use a rule when the response depends on context, wording, or
anything you would have to think about. That is what waking you is for. A rule
that tries to be clever will be wrong in exactly the cases that matter.

A good signal: if you find yourself woken three times for near-identical
messages and giving near-identical replies, that is a rule.

## Format

```yaml
rules:
  - name: deploy-failed
    when:
      contains: "deploy failed"
    do:
      - react: "🚨"
    cooldownSeconds: 30
```

**Conditions** (`when`) — at least one is required:

| Key | Meaning |
|---|---|
| `contains` | Case-insensitive substring |
| `matches` | Regex, case-insensitive, max 400 chars |
| `channel` | Channel id, or a list |
| `author` | Author id, or a list |
| `allowBots` | Set true to match bot messages too (default false) |

**Actions** (`do`) — at least one:

| Action | Effect |
|---|---|
| `react: "👀"` | Add a reaction |
| `reply: "text"` | Reply to the message |
| `send: { channel: "<id>", text: "…" }` | Post to another channel |
| `log: "text"` | Write to the service journal only |

Text supports `{author}`, `{authorId}`, `{content}`, `{channelId}`,
`{messageId}`.

**Other keys:**

- `stopWake` — defaults **true**: the rule handles it and you are not woken.
  Set `false` to act *and* still be woken, which is the right choice when you
  want an instant acknowledgement followed by real work.
- `cooldownSeconds` — minimum gap between firings, per channel.

## Rules that will bite you if ignored

**These are data, not code.** There is no action that runs a command, and
adding one is not an oversight to work around — the waker is unsandboxed and
holds the bot token, so an executable rule would be a way out of your sandbox.
If a task genuinely needs to run something, do it yourself in a turn.

**A rule with no conditions is rejected.** It would fire on every message. The
file fails to load and the previous rules stay live.

**Always set `cooldownSeconds` on anything that replies or sends.** Without it,
a busy channel produces one bot message per human message. 30–60 seconds is
usually right.

**A broken file does not take effect.** The engine keeps the last good set and
logs why. Your edit silently doing nothing means it failed to parse — check.

**Reactions need the emoji to be available to the bot.** Unicode emoji always
work; custom server emoji need `name:id` form.

## After editing, verify it loaded

```bash
journalctl -u clawcius -n 20 --no-pager | grep -i rules
```

You want a line like:

```
[rules] loaded 3 rule(s) (file changed)
```

If instead you see `[rules] reload FAILED`, the message says which rule and
why. Fix it and save again — the file reloads on every write.

To confirm a rule actually fires, post a matching message and look for:

```
[clawcius <channel>] handled by rule "deploy-failed" — no wake
```

## Common patterns

```yaml
rules:
  # Instant acknowledgement, then hand off to yourself for the real work.
  - name: incident
    when: { matches: "(prod|production) (is )?(down|broken)" }
    do:
      - react: "🚨"
    stopWake: false          # still wake me — this needs judgement

  # Fully handled, never wakes anyone.
  - name: thanks
    when: { matches: "^(thanks|ty|cheers),? clawcius" }
    do:
      - react: "🫡"
    cooldownSeconds: 10

  # Watch another bot and mirror its alerts.
  - name: ci-alerts
    when:
      contains: "build failed"
      allowBots: true
    do:
      - send: { channel: "<channel-id>", text: "CI: {content}" }
    cooldownSeconds: 60
```

## Getting channel and author ids

`discord channels` lists channel ids. Message objects from `discord read`
carry `author_id`. Never guess an id — a wrong one means the rule silently
never matches.

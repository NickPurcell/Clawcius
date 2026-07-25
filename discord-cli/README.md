# discord-cli

A small Discord CLI for a single server, designed to be driven by an AI agent.

Standard library only — no `pip install` required. Any machine with Python 3.11+
can run it.

```bash
./discord channels
./discord send --channel general --text "hello"
```

## Setup

1. **Create the bot** at <https://discord.com/developers/applications> → your app
   → *Bot* → Reset Token, and copy the token.
2. **Invite it**: *OAuth2 → URL Generator*, scope `bot`, permissions: View
   Channels, Send Messages, Read Message History, Add Reactions, Manage Messages.
   Open the generated URL and add the bot to your server.
3. **Configure**:

   ```bash
   export DISCORD_TOKEN='...'          # or put token = "..." in the config file
   ./discord guilds                    # find your server's ID
   ./discord config set-guild <id>
   ./discord whoami                    # verify
   ```

Config lives at `~/.config/discord-cli/config.toml`, written `chmod 600`.
`DISCORD_TOKEN` and `DISCORD_GUILD_ID` take precedence over the file. The token
is deliberately not accepted as a flag — flags leak into shell history and `ps`.

To put `discord` on your PATH permanently, either symlink this script or
`pip install -e .` if you have pip available.

## Commands

| Command | Purpose |
|---|---|
| `channels` | List text channels visible to the bot |
| `read` | Recent messages in a channel, newest first |
| `search` | Filter a channel's history by text, author, or date |
| `send` | Post a message (reads stdin if `--text` is omitted) |
| `reply` | Reply to a specific message |
| `react` | Add a reaction |
| `edit` | Edit one of the bot's own messages |
| `delete` | Delete a message (requires `--confirm`) |
| `whoami` | Bot identity and configured server |
| `guilds` | Servers the bot belongs to |
| `config show` / `config set-guild` | Inspect and set configuration |

`--channel` takes a name or an ID. Run `discord <command> --help` for flags.

## Design notes

The tool is shaped around being called by an agent rather than typed by a human.

**No mutable context.** There is deliberately no `discord use <channel>`. A
stored "current channel" is state the caller cannot see and cannot recover from
when it is wrong. Every command names its channel.

**Format follows the TTY.** A terminal gets an aligned table; a pipe gets JSON.
`--output json|text` overrides. Data is always on stdout and diagnostics always
on stderr, so redirecting stdout to a file never captures an error object where
data was expected.

**Exit codes are a contract**: `0` ok, `1` API error, `2` auth, `3` bad input,
`4` confirmation required. They let a caller branch without parsing prose.

**Destructive actions exit, they do not prompt.** `delete` prints the target
message and exits 4; the caller re-runs with `--confirm`. An interactive prompt
would be a hang, not a question.

**Messages are slimmed by default.** A raw Discord message object is ~40 lines
of nested JSON; reading 50 of them would spend thousands of tokens on fields
nobody asked for. `--full` gives the raw object when a missing field is needed.

**Input is validated locally first.** A malformed snowflake or an over-long
message is rejected before any network call, so the caller gets a precise error
in one fast turn instead of an opaque HTTP 400.

**No abbreviated flags, no "did you mean".** Flags are a stable contract, and a
caller that reads a suggestion as a confirmation will run the wrong command.

## Known limits

`search` is not exhaustive. Discord's server-side search endpoint is not
available to bot accounts, so search pages backwards through history and filters
locally, bounded by `--max-scan` (default 500). Every run reports its coverage on
stderr; a capped scan is reported as capped rather than as "no results". If this
becomes the bottleneck, the fix is a local SQLite FTS index behind the same
`search` interface.

Not implemented: file uploads, DMs, threads, pins, and live tailing. Tailing is
the only one that needs a Gateway websocket connection; everything else is REST.

## Agent skill

`.claude/skills/discord-cli/SKILL.md` in the parent directory documents this tool
for agent use — command surface, exit-code handling, and the failure modes worth
knowing.

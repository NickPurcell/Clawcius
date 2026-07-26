"""discord -- a small Discord CLI meant to be driven by an AI agent.

Design rules, in case they are not obvious from the code:

  * No mutable context. Every command names its channel explicitly. A stored
    "current channel" would be hidden state the caller cannot see and cannot
    recover from when it is wrong.
  * Output format follows the TTY: table for humans, JSON for pipes and agents.
  * Data on stdout, diagnostics on stderr.
  * Exit codes are a contract (see errors.py).
  * Destructive commands refuse and exit 4 rather than prompting, because a
    prompt is a hang, not a question.
  * No abbreviated flags and no "did you mean" guessing. Flags are a stable
    contract, and a caller that misreads a suggestion as a confirmation will
    happily run the wrong command.
"""

import argparse
import select
import sys
from datetime import datetime, timezone

from . import config, download, render, resolve, upload
from .api import Client
from .errors import CONFIRM_REQUIRED, OK, VALIDATION_ERROR, CliError, ValidationError

MAX_MESSAGE_LEN = 2000

_state = {"output": "auto"}


def _as_json():
    return render.json_mode(_state["output"])


def _out(data, text_renderer):
    render.emit(data, _as_json(), text_renderer)


def _note(message):
    """Diagnostics belong on stderr so they never contaminate piped data."""
    sys.stderr.write(message.rstrip("\n") + "\n")


class Parser(argparse.ArgumentParser):
    """Usage errors exit 3 (validation), not argparse's default of 2 (which we
    reserve for auth failures)."""

    def error(self, message):
        sys.stderr.write(f"error: {message}\n")
        sys.stderr.write(f"hint:  run '{self.prog} --help' for usage.\n")
        sys.exit(VALIDATION_ERROR)


# -- commands --------------------------------------------------------------


def cmd_whoami(args):
    with Client() as client:
        me = client.me()
        data = {
            "id": me["id"],
            "username": me.get("username"),
            "global_name": me.get("global_name"),
            "bot": bool(me.get("bot")),
        }
        try:
            guild_id = config.get_guild_id()
            data["guild_id"] = guild_id
            match = [g for g in client.my_guilds() if g["id"] == guild_id]
            data["guild_name"] = match[0]["name"] if match else None
            if not match:
                data["warning"] = "Configured guild_id is not a server this bot belongs to."
        except CliError:
            data["guild_id"] = None
            data["warning"] = "No guild configured. Run 'discord guilds'."
    _out(data, render.kv_table)


def cmd_guilds(args):
    with Client() as client:
        data = [{"id": g["id"], "name": g["name"]} for g in client.my_guilds()]
    _out(data, lambda rows: "\n".join(f"{r['id']:<20} {r['name']}" for r in rows) or "(none)")


def cmd_channels(args):
    guild_id = config.get_guild_id()
    with Client() as client:
        data = [
            render.slim_channel(c)
            for c in resolve.list_channels(client, guild_id, refresh=args.refresh)
        ]
    _out(data, render.channels_table)


def cmd_read(args):
    if not 1 <= args.limit <= 100:
        raise ValidationError(
            f"--limit must be between 1 and 100 (got {args.limit}).",
            remediation="For more than 100, page with --before using the oldest ID returned.",
        )
    before = resolve.validate_snowflake(args.before, "message id") if args.before else None
    after = resolve.validate_snowflake(args.after, "message id") if args.after else None

    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        messages = client.get_messages(channel_id, limit=args.limit, before=before, after=after)

    _out(messages if args.full else [render.slim_message(m) for m in messages], render.messages_table)


def cmd_search(args):
    """Discord's server-side search endpoint is unavailable to bot accounts, so
    this pages backwards through history and filters locally. That makes it
    bounded by --max-scan rather than exhaustive, which the stderr summary
    reports on every run."""
    if not any([args.query, args.author, args.since]):
        raise ValidationError(
            "Nothing to search for.",
            remediation="Pass at least one of --query, --author, or --since.",
        )
    if args.limit < 1:
        raise ValidationError("--limit must be at least 1.")

    since_dt = _parse_since(args.since) if args.since else None
    needle = args.query.lower() if args.query else None
    author_needle = args.author.lower() if args.author else None

    def matches(msg):
        if needle and needle not in (msg.get("content") or "").lower():
            return False
        if author_needle:
            a = msg.get("author") or {}
            candidates = [
                str(a.get("id") or "").lower(),
                str(a.get("username") or "").lower(),
                str(a.get("global_name") or "").lower(),
            ]
            if not any(c and author_needle in c for c in candidates):
                return False
        if since_dt:
            ts = _parse_ts(msg.get("timestamp"))
            if ts is None or ts < since_dt:
                return False
        return True

    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        found, scanned, exhausted = _scan_history(
            client, channel_id, matches, args.limit, args.max_scan, stop_before=since_dt
        )

    _out(found if args.full else [render.slim_message(m) for m in found], render.messages_table)

    coverage = (
        "reached the start of the channel"
        if exhausted
        else f"stopped at the --max-scan limit of {args.max_scan}"
    )
    _note(f"searched {scanned} message(s); {len(found)} match(es); {coverage}.")


def _scan_history(client, channel_id, predicate, limit, max_scan, stop_before=None):
    """Page backwards collecting matches. Returns (matches, scanned, hit_start)."""
    found, scanned, cursor = [], 0, None
    while len(found) < limit and scanned < max_scan:
        # Ask for only what the scan budget allows, and judge "end of channel"
        # against that number -- a short batch because we asked for a short
        # batch is not the same as running out of history.
        requested = min(100, max_scan - scanned)
        batch = client.get_messages(channel_id, limit=requested, before=cursor)
        if not batch:
            return found, scanned, True
        for msg in batch:
            scanned += 1
            if predicate(msg):
                found.append(msg)
                if len(found) >= limit:
                    return found, scanned, False
        # Once we are older than --since, nothing further back can match.
        if stop_before is not None:
            oldest = _parse_ts(batch[-1].get("timestamp"))
            if oldest is not None and oldest < stop_before:
                return found, scanned, True
        if len(batch) < requested:
            return found, scanned, True
        cursor = batch[-1]["id"]
    return found, scanned, False


def cmd_send(args):
    files = upload.load_files(args.file, max_total_bytes=args.max_upload_bytes)
    content = _resolve_text(args.text, allow_empty=bool(files))
    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        sent = client.send_message(channel_id, content, files=files)
    _out(render.slim_message(sent), lambda m: f"sent {m['id']}")


def cmd_reply(args):
    message_id = resolve.validate_snowflake(args.message, "message id")
    files = upload.load_files(args.file, max_total_bytes=args.max_upload_bytes)
    content = _resolve_text(args.text, allow_empty=bool(files))
    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        sent = client.send_message(channel_id, content, reply_to=message_id, files=files)
    _out(render.slim_message(sent), lambda m: f"replied {m['id']}")


def cmd_react(args):
    message_id = resolve.validate_snowflake(args.message, "message id")
    emoji = resolve.normalize_emoji(args.emoji)
    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        client.add_reaction(channel_id, message_id, emoji)
    _out(
        {"ok": True, "message_id": message_id, "emoji": emoji},
        lambda d: f"reacted {d['emoji']} to {d['message_id']}",
    )


def cmd_edit(args):
    message_id = resolve.validate_snowflake(args.message, "message id")
    content = _resolve_text(args.text)
    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        updated = client.edit_message(channel_id, message_id, content)
    _out(render.slim_message(updated), lambda m: f"edited {m['id']}")


def cmd_delete(args):
    message_id = resolve.validate_snowflake(args.message, "message id")
    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        target = client.get_message(channel_id, message_id)

        if not args.confirm:
            preview = {
                "confirmation_required": True,
                "action": "delete_message",
                "target": render.slim_message(target),
                "rerun_with": "--confirm",
            }
            _out(
                preview,
                lambda d: (
                    "would delete:\n"
                    + render.messages_table([d["target"]])
                    + "\nre-run with --confirm to proceed"
                ),
            )
            return CONFIRM_REQUIRED

        client.delete_message(channel_id, message_id)
    _out({"ok": True, "deleted": message_id}, lambda d: f"deleted {d['deleted']}")


def cmd_download(args):
    """Save attachments to disk, either a whole message's worth or one URL.

    The URL form exists because attachment links are signed and expire: when a
    caller already holds a fresh URL there is no reason to spend a round trip
    re-reading the message to rediscover it.
    """
    if args.max_bytes < 1:
        raise ValidationError("--max-bytes must be at least 1.")

    if args.url:
        if args.channel or args.message:
            raise ValidationError(
                "--url cannot be combined with --channel or --message.",
                remediation="Use --url on its own, or --channel with --message.",
            )
        out_dir = download.ensure_dir(args.out)
        saved = [
            download.fetch(
                args.url, out_dir, max_bytes=args.max_bytes, overwrite=args.overwrite
            )
        ]
        _out(saved, render.downloads_table)
        return

    if not (args.channel and args.message):
        raise ValidationError(
            "Nothing to download.",
            remediation="Pass --channel and --message together, or --url with an attachment URL.",
        )

    message_id = resolve.validate_snowflake(args.message, "message id")
    guild_id = config.get_guild_id()
    with Client() as client:
        channel_id = resolve.resolve_channel(client, guild_id, args.channel)
        message = client.get_message(channel_id, message_id)

    attachments = message.get("attachments") or []
    if not attachments:
        raise ValidationError(
            f"Message {message_id} has no attachments.",
            remediation="Run 'discord read --channel <name>' to find one that does.",
        )

    out_dir = download.ensure_dir(args.out)
    saved = []
    for attachment in attachments:
        record = download.fetch(
            attachment.get("url"),
            out_dir,
            filename=attachment.get("filename"),
            max_bytes=args.max_bytes,
            overwrite=args.overwrite,
        )
        record["attachment_id"] = attachment.get("id")
        saved.append(record)
    _out(saved, render.downloads_table)


def cmd_config_show(args):
    _out(config.describe(), render.kv_table)


def cmd_config_set_guild(args):
    resolve.validate_snowflake(args.guild_id, "guild id")
    config.set_guild_id(args.guild_id)
    _out(
        {"ok": True, "guild_id": args.guild_id, "config_file": str(config.CONFIG_FILE)},
        lambda d: f"guild set to {d['guild_id']} in {d['config_file']}",
    )


# -- parser ----------------------------------------------------------------


def build_parser():
    # --output is accepted before or after the subcommand. SUPPRESS keeps an
    # unspecified copy from clobbering a specified one.
    common = Parser(add_help=False, allow_abbrev=False)
    common.add_argument(
        "--output", "-o",
        choices=["json", "text", "auto"],
        default=argparse.SUPPRESS,
        help="Output format. Default auto: JSON when stdout is not a TTY, table when it is.",
    )

    parser = Parser(
        prog="discord",
        description="Interact with one Discord server. Designed for AI agents: JSON output when piped.",
        parents=[common],
        allow_abbrev=False,
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>", required=True)

    def add(name, func, help_text, **kwargs):
        p = sub.add_parser(
            name, help=help_text, description=help_text, parents=[common], allow_abbrev=False, **kwargs
        )
        p.set_defaults(func=func)
        return p

    add("whoami", cmd_whoami, "Show the authenticated bot account and the configured server.")
    add("guilds", cmd_guilds, "List servers this bot is in (use this to find your guild ID).")

    p = add("channels", cmd_channels, "List text channels visible to the bot in the configured server.")
    p.add_argument("--refresh", action="store_true", help="Bypass the local name cache.")

    p = add("read", cmd_read, "Read recent messages from a channel, newest first.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID.")
    p.add_argument("--limit", "-n", type=int, default=20, help="Messages to return, 1-100. Default 20.")
    p.add_argument("--before", help="Return messages older than this message ID (pagination).")
    p.add_argument("--after", help="Return messages newer than this message ID.")
    p.add_argument("--full", action="store_true", help="Emit raw Discord objects instead of slim ones.")

    p = add("search", cmd_search, "Search a channel's history by text, author, or date.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID to search.")
    p.add_argument("--query", "-q", help="Case-insensitive substring to find in message content.")
    p.add_argument("--author", help="Filter by author username or ID.")
    p.add_argument("--since", help="Only messages at or after this date (YYYY-MM-DD or ISO 8601).")
    p.add_argument("--limit", "-n", type=int, default=20, help="Maximum matches to return. Default 20.")
    p.add_argument("--max-scan", type=int, default=500, help="History depth to scan. Default 500.")
    p.add_argument("--full", action="store_true", help="Emit raw Discord objects instead of slim ones.")

    p = add("send", cmd_send, "Send a message to a channel. Reads stdin when --text is omitted.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID.")
    p.add_argument("--text", "-t", help="Message text. If omitted, read from stdin.")
    p.add_argument(
        "--file", "-f", action="append", metavar="PATH",
        help="File to attach. Repeat for up to 10. Text is optional when a file is attached.",
    )
    p.add_argument(
        "--max-upload-bytes", type=int, default=upload.MAX_UPLOAD_BYTES,
        help=(
            "Client-side size ceiling for the whole message. Default 10 MiB, which is "
            "the limit on an unboosted server; raise it to 52428800 or 104857600 on a "
            "server at boost tier 2 or 3."
        ),
    )

    p = add("reply", cmd_reply, "Reply to a specific message.")
    p.add_argument("--message", "-m", required=True, help="ID of the message to reply to.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID containing that message.")
    p.add_argument("--text", "-t", help="Reply text. If omitted, read from stdin.")
    p.add_argument(
        "--file", "-f", action="append", metavar="PATH",
        help="File to attach. Repeat for up to 10. Text is optional when a file is attached.",
    )
    p.add_argument(
        "--max-upload-bytes", type=int, default=upload.MAX_UPLOAD_BYTES,
        help=(
            "Client-side size ceiling for the whole message. Default 10 MiB, which is "
            "the limit on an unboosted server; raise it to 52428800 or 104857600 on a "
            "server at boost tier 2 or 3."
        ),
    )

    p = add("react", cmd_react, "Add a reaction to a message.")
    p.add_argument("--message", "-m", required=True, help="ID of the message to react to.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID containing that message.")
    p.add_argument("--emoji", "-e", required=True, help="Unicode emoji, :shortcode:, or 'name:id' for custom.")

    p = add("edit", cmd_edit, "Edit one of the bot's own messages.")
    p.add_argument("--message", "-m", required=True, help="ID of the message to edit.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID containing that message.")
    p.add_argument("--text", "-t", help="Replacement text. If omitted, read from stdin.")

    p = add("delete", cmd_delete, "Delete a message. Requires --confirm; without it, previews and exits 4.")
    p.add_argument("--message", "-m", required=True, help="ID of the message to delete.")
    p.add_argument("--channel", "-c", required=True, help="Channel name or ID containing that message.")
    p.add_argument("--confirm", action="store_true", help="Required to actually delete.")

    p = add("download", cmd_download, "Save a message's attachments to disk.")
    p.add_argument("--channel", "-c", help="Channel name or ID containing the message.")
    p.add_argument("--message", "-m", help="ID of the message whose attachments to save.")
    p.add_argument(
        "--url",
        help="Download one attachment URL directly, instead of --channel/--message.",
    )
    p.add_argument(
        "--out", default=".", metavar="DIR",
        help="Directory to write into, created if absent. Default: the current directory. "
             "(-o is taken by --output.)",
    )
    p.add_argument(
        "--max-bytes", type=int, default=download.DEFAULT_MAX_BYTES,
        help=f"Refuse an attachment larger than this. Default {download.DEFAULT_MAX_BYTES}.",
    )
    p.add_argument(
        "--overwrite", action="store_true",
        help="Replace an existing file of the same name instead of refusing.",
    )

    cfg = add("config", None, "Inspect and set local configuration.")
    cfg_sub = cfg.add_subparsers(dest="subcommand", metavar="<subcommand>", required=True)

    c = cfg_sub.add_parser(
        "show", help="Show resolved configuration and where each value came from.",
        parents=[common], allow_abbrev=False,
    )
    c.set_defaults(func=cmd_config_show)

    c = cfg_sub.add_parser(
        "set-guild", help="Pin the single server this CLI operates on.",
        parents=[common], allow_abbrev=False,
    )
    c.add_argument("guild_id", help="The server ID this CLI should operate on.")
    c.set_defaults(func=cmd_config_set_guild)

    return parser


# -- helpers ---------------------------------------------------------------


def _resolve_text(text, allow_empty=False):
    """Message text from --text or stdin.

    `allow_empty` is set when the message carries an attachment, and it changes
    how hard we are willing to wait for stdin. Without a file, blocking on stdin
    is correct -- text is the only thing the message could be, so there is
    nothing to do but wait for it. With a file the caption is optional, and
    blocking is a trap: an unattended caller that never redirects stdin (a
    script, a service, an agent shelling out) has a pipe that is neither a tty
    nor ever written to, and read() there hangs forever rather than erroring.
    So when a file is attached we only take stdin that is already there.
    """
    if text is None:
        if allow_empty and not _stdin_ready():
            return ""
        if sys.stdin.isatty():
            raise ValidationError(
                "No message text provided.",
                remediation='Pass --text "..." or pipe the text in on stdin.',
            )
        text = sys.stdin.read()
    text = text.rstrip("\n")
    if not text.strip():
        if allow_empty:
            return ""
        raise ValidationError(
            "Message text is empty.",
            remediation="Discord rejects empty messages. Provide non-whitespace content.",
        )
    if len(text) > MAX_MESSAGE_LEN:
        raise ValidationError(
            f"Message is {len(text)} characters; Discord's limit is {MAX_MESSAGE_LEN}.",
            remediation="Split it into multiple messages.",
        )
    return text


def _stdin_ready():
    """Is there input on stdin we can take without waiting?

    A tty is never "ready": the human has not typed yet, and treating an empty
    terminal as an empty caption would swallow the prompt. Anything else is
    asked with a zero timeout, so a pipe nobody will ever write to reports as
    empty instead of blocking the process forever.
    """
    if sys.stdin.isatty():
        return False
    try:
        readable, _, _ = select.select([sys.stdin], [], [], 0)
    except (OSError, ValueError):
        return True  # not selectable: fall back to the blocking read
    return bool(readable)


def _parse_since(value):
    raw = value.strip()
    try:
        parsed = (
            datetime.strptime(raw, "%Y-%m-%d")
            if len(raw) == 10
            else datetime.fromisoformat(raw.replace("Z", "+00:00"))
        )
    except ValueError:
        raise ValidationError(
            f"Could not parse --since value '{value}'.",
            remediation="Use YYYY-MM-DD or a full ISO 8601 timestamp.",
        )
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_ts(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    _state["output"] = getattr(args, "output", "auto")

    try:
        code = args.func(args)
    except CliError as exc:
        render.emit_error(exc, _as_json())
        return exc.code
    except BrokenPipeError:
        return OK  # downstream closed the pipe, e.g. `| head`
    except KeyboardInterrupt:
        return 130
    return code if isinstance(code, int) else OK


def entrypoint():
    sys.exit(main())


if __name__ == "__main__":
    entrypoint()

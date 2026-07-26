"""Output. Data goes to stdout, diagnostics go to stderr, always.

Format is chosen by TTY detection: a human at a terminal gets a table, a pipe
or an agent gets JSON, and neither has to pass a flag.

The slim projections matter more than they look. A raw Discord message object
is roughly forty lines of nested JSON; a channel read of fifty of them would
spend thousands of tokens on fields nobody asked for. Everything is projected
down by default, with --full available when the raw object is genuinely needed.
"""

import json
import shutil
import sys


def json_mode(output_flag):
    if output_flag in ("json", "text"):
        return output_flag == "json"
    return not sys.stdout.isatty()


def emit(data, as_json, text_renderer):
    if as_json:
        json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        text = text_renderer(data)
        if text:
            sys.stdout.write(text.rstrip("\n") + "\n")


def emit_error(err, as_json):
    """Errors never touch stdout -- an agent piping stdout to a file must not
    receive an error object where it expects data."""
    if as_json:
        json.dump(err.to_dict(), sys.stderr, indent=2, ensure_ascii=False)
        sys.stderr.write("\n")
    else:
        sys.stderr.write(f"error: {err.message}\n")
        if err.remediation:
            sys.stderr.write(f"hint:  {err.remediation}\n")


# -- projections -----------------------------------------------------------


def slim_message(msg):
    author = msg.get("author") or {}
    out = {
        "id": msg.get("id"),
        "author": author.get("global_name") or author.get("username"),
        "author_id": author.get("id"),
        "content": msg.get("content", ""),
        "ts": msg.get("timestamp"),
    }
    if msg.get("edited_timestamp"):
        out["edited_ts"] = msg["edited_timestamp"]

    ref = msg.get("referenced_message") or {}
    msg_ref = msg.get("message_reference") or {}
    if ref.get("id") or msg_ref.get("message_id"):
        out["reply_to"] = ref.get("id") or msg_ref.get("message_id")

    reactions = msg.get("reactions") or []
    if reactions:
        out["reactions"] = [
            {"emoji": (r.get("emoji") or {}).get("name"), "count": r.get("count")}
            for r in reactions
        ]

    attachments = msg.get("attachments") or []
    if attachments:
        # Enough to decide whether to download without a second --full round
        # trip: what it is, how large, and the id to name it by.
        out["attachments"] = [
            {
                "id": a.get("id"),
                "filename": a.get("filename"),
                "size": a.get("size"),
                "content_type": a.get("content_type"),
                "url": a.get("url"),
            }
            for a in attachments
        ]

    if author.get("bot"):
        out["is_bot"] = True
    return out


def slim_channel(ch):
    return {"id": ch["id"], "name": ch["name"], "type": ch.get("type")}


# -- text renderers --------------------------------------------------------


def _term_width():
    return shutil.get_terminal_size((100, 24)).columns


def _short_ts(ts):
    if not ts:
        return ""
    return ts[5:16].replace("T", " ")


def messages_table(messages):
    if not messages:
        return "(no messages)"
    width = _term_width()
    author_w = min(16, max((len(m.get("author") or "") for m in messages), default=6))
    prefix_w = 20 + 12 + author_w + 6
    content_w = max(20, width - prefix_w)

    lines = []
    for m in messages:
        content = (m.get("content") or "").replace("\n", " ⏎ ")
        if not content and m.get("attachments"):
            content = f"[{len(m['attachments'])} attachment(s)]"
        if len(content) > content_w:
            content = content[: content_w - 1] + "…"
        reacts = ""
        if m.get("reactions"):
            reacts = "  " + " ".join(f"{r['emoji']}{r['count']}" for r in m["reactions"])
        lines.append(
            f"{m['id']:<20} {_short_ts(m.get('ts')):<12} "
            f"{(m.get('author') or ''):<{author_w}}  {content}{reacts}"
        )
        lines.extend(_attachment_lines(m.get("attachments")))
    return "\n".join(lines)


def _attachment_lines(attachments):
    """One indented line per attachment, so a file is visible without --full."""
    lines = []
    for att in attachments or []:
        bits = [att.get("filename") or "(unnamed)"]
        if att.get("size") is not None:
            bits.append(human_size(att.get("size")))
        if att.get("content_type"):
            bits.append(att["content_type"])
        if att.get("id"):
            bits.append(f"id {att['id']}")
        lines.append("    ↳ " + "  ".join(bits))
    return lines


def downloads_table(saved):
    if not saved:
        return "(nothing downloaded)"
    return "\n".join(
        f"{human_size(f.get('size')):>10}  {(f.get('content_type') or ''):<24}  {f.get('path')}"
        for f in saved
    )


def channels_table(channels):
    if not channels:
        return "(no channels visible to this bot)"
    return "\n".join(f"{c['id']:<20} #{c['name']}" for c in channels)


def human_size(num):
    """Bytes in the units a person reads. Binary units, as Discord counts them."""
    if num is None:
        return "?"
    try:
        value = float(num)
    except (TypeError, ValueError):
        return "?"
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024


def kv_table(data):
    if not isinstance(data, dict):
        return str(data)
    width = max((len(str(k)) for k in data), default=0)
    return "\n".join(f"{k:<{width}}  {v}" for k, v in data.items())

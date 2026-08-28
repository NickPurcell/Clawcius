"""Turning human-typed names into snowflake IDs, and validating IDs locally."""

import json
import re
import time

from . import config
from .errors import ValidationError

SNOWFLAKE_RE = re.compile(r"^\d{17,20}$")
CACHE_TTL_SECONDS = 300

# Channel types that can hold messages we care about.
TEXT_CHANNEL_TYPES = {0, 5, 10, 11, 12, 15}


def is_snowflake(value):
    return bool(SNOWFLAKE_RE.match(str(value).strip()))


def validate_snowflake(value, label="id"):
    value = str(value).strip()
    if not is_snowflake(value):
        raise ValidationError(
            f"'{value}' is not a valid Discord {label}.",
            remediation=(
                f"A {label} is a numeric snowflake of 17-20 digits. In Discord, enable "
                "Developer Mode then right-click -> Copy ID."
            ),
        )
    return value


def resolve_channel(client, guild_id, channel):
    """Accept a snowflake, '#general', or 'general' and return a channel ID."""
    if channel is None:
        raise ValidationError(
            "No channel specified.",
            remediation="Pass --channel <name|id>. Run 'discord channels' to list them.",
        )

    channel = str(channel).strip()
    if is_snowflake(channel):
        return channel

    name = channel.lstrip("#").lower()
    channels = list_channels(client, guild_id)

    exact = [c for c in channels if c["name"].lower() == name]
    if len(exact) == 1:
        return exact[0]["id"]
    if len(exact) > 1:
        raise ValidationError(
            f"Channel name '{name}' is ambiguous ({len(exact)} matches).",
            remediation="Pass the channel ID instead. Run 'discord channels' to see IDs.",
        )

    available = ", ".join(sorted(c["name"] for c in channels)[:40]) or "(none visible)"
    raise ValidationError(
        f"No channel named '{name}' is visible to this bot.",
        remediation=f"Available channels: {available}",
    )


def list_channels(client, guild_id, refresh=False):
    """Text channels in the configured guild, cached briefly on disk."""
    if not refresh:
        cached = _read_cache(guild_id)
        if cached is not None:
            return cached

    raw = client.guild_channels(guild_id)
    channels = [
        {"id": c["id"], "name": c["name"], "type": c["type"], "parent_id": c.get("parent_id")}
        for c in raw
        if c.get("type") in TEXT_CHANNEL_TYPES
    ]
    channels.sort(key=lambda c: c["name"])
    _write_cache(guild_id, channels)
    return channels


def _read_cache(guild_id):
    try:
        blob = json.loads(config.CACHE_FILE.read_text())
    except (OSError, ValueError):
        return None
    entry = blob.get(str(guild_id))
    if not entry:
        return None
    if time.time() - entry.get("fetched_at", 0) > CACHE_TTL_SECONDS:
        return None
    return entry.get("channels")


def _write_cache(guild_id, channels):
    try:
        blob = json.loads(config.CACHE_FILE.read_text())
    except (OSError, ValueError):
        blob = {}
    blob[str(guild_id)] = {"fetched_at": time.time(), "channels": channels}
    try:
        config.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        config.CACHE_FILE.write_text(json.dumps(blob))
    except OSError:
        pass  # A cache write failure must never fail the command.


# Enough shortcodes to cover ordinary use; anything else passes through so that
# unicode emoji and custom 'name:id' emoji both still work.
SHORTCODES = {
    "+1": "\N{THUMBS UP SIGN}",
    "thumbsup": "\N{THUMBS UP SIGN}",
    "-1": "\N{THUMBS DOWN SIGN}",
    "thumbsdown": "\N{THUMBS DOWN SIGN}",
    "fire": "\N{FIRE}",
    "eyes": "\N{EYES}",
    "heart": "\N{HEAVY BLACK HEART}",
    "tada": "\N{PARTY POPPER}",
    "rocket": "\N{ROCKET}",
    "white_check_mark": "\N{WHITE HEAVY CHECK MARK}",
    "check": "\N{WHITE HEAVY CHECK MARK}",
    "x": "\N{CROSS MARK}",
    "warning": "\N{WARNING SIGN}",
    "laughing": "\N{SMILING FACE WITH OPEN MOUTH AND TIGHTLY-CLOSED EYES}",
    "smile": "\N{SMILING FACE WITH OPEN MOUTH AND SMILING EYES}",
    "cry": "\N{CRYING FACE}",
    "wave": "\N{WAVING HAND SIGN}",
    "pray": "\N{PERSON WITH FOLDED HANDS}",
    "clap": "\N{CLAPPING HANDS SIGN}",
    "100": "\N{HUNDRED POINTS SYMBOL}",
    "point_up": "\N{WHITE UP POINTING INDEX}",
}


def normalize_emoji(emoji):
    """Accept a unicode emoji, ':shortcode:', or custom 'name:id'."""
    if not emoji:
        raise ValidationError(
            "No emoji specified.",
            remediation="Pass --emoji with a unicode emoji, a :shortcode:, or 'name:id' for custom emoji.",
        )
    emoji = emoji.strip()
    if emoji.startswith(":") and emoji.endswith(":") and len(emoji) > 2:
        key = emoji[1:-1].lower()
        if key in SHORTCODES:
            return SHORTCODES[key]
        raise ValidationError(
            f"Unknown emoji shortcode ':{key}:'.",
            remediation=(
                "Pass the unicode emoji directly instead. For a custom server emoji use "
                "'name:id' (right-click the emoji -> Copy Link to find the id)."
            ),
        )
    return emoji

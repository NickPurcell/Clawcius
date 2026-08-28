"""Token and guild resolution.

Precedence for both values: environment variable, then config file. The token
is never accepted as a flag -- flags land in shell history and `ps` output.
"""

import os
import tomllib
from pathlib import Path

from .errors import AuthError, ValidationError

CONFIG_DIR = Path(os.environ.get("DISCORD_CLI_HOME", Path.home() / ".config" / "discord-cli"))
CONFIG_FILE = CONFIG_DIR / "config.toml"
CACHE_FILE = CONFIG_DIR / "cache.json"

SETUP_HINT = (
    "Set DISCORD_TOKEN=<bot token>, or write it to "
    f"{CONFIG_FILE} as: token = \"...\""
)


def _read_file():
    if not CONFIG_FILE.exists():
        return {}
    try:
        with CONFIG_FILE.open("rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ValidationError(
            f"Could not read config file {CONFIG_FILE}: {exc}",
            remediation="Fix the TOML syntax or delete the file and re-run 'discord config set-guild'.",
        )


def get_token():
    token = os.environ.get("DISCORD_TOKEN") or _read_file().get("token")
    if not token:
        raise AuthError("No bot token found.", remediation=SETUP_HINT)
    return token.strip()


def get_guild_id(override=None):
    """The single server this CLI operates against."""
    guild = override or os.environ.get("DISCORD_GUILD_ID") or _read_file().get("guild_id")
    if not guild:
        raise ValidationError(
            "No guild configured.",
            remediation=(
                "Run 'discord guilds' to list servers this bot is in, then "
                "'discord config set-guild <id>'. Or set DISCORD_GUILD_ID."
            ),
        )
    return str(guild).strip()


def set_guild_id(guild_id):
    data = _read_file()
    data["guild_id"] = str(guild_id)
    _write_file(data)
    return guild_id


def _write_file(data):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    lines = []
    for key, value in data.items():
        escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'{key} = "{escaped}"')
    CONFIG_FILE.write_text("\n".join(lines) + "\n")
    CONFIG_FILE.chmod(0o600)


def describe():
    """Config state for `discord config show`, with the token redacted."""
    file_data = _read_file()
    token_source = None
    if os.environ.get("DISCORD_TOKEN"):
        token_source = "env:DISCORD_TOKEN"
    elif file_data.get("token"):
        token_source = f"file:{CONFIG_FILE}"

    guild_source = None
    if os.environ.get("DISCORD_GUILD_ID"):
        guild_source = "env:DISCORD_GUILD_ID"
    elif file_data.get("guild_id"):
        guild_source = f"file:{CONFIG_FILE}"

    return {
        "config_file": str(CONFIG_FILE),
        "token_configured": token_source is not None,
        "token_source": token_source,
        "guild_id": os.environ.get("DISCORD_GUILD_ID") or file_data.get("guild_id"),
        "guild_source": guild_source,
    }

"""Thin HTTP client for the Discord REST API, with rate-limit handling.

Standard library only, so the tool runs anywhere python3 does with no install
step. Rate limiting lives here rather than at the call sites, so adding a new
command never means remembering to handle 429s.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config
from .errors import AuthError, CliError

BASE_URL = "https://discord.com/api/v10"
USER_AGENT = "DiscordBot (https://github.com/local/discord-cli, 0.1.0)"

MAX_RETRIES = 5
DEFAULT_TIMEOUT = 15.0


class Client:
    def __init__(self, token=None, timeout=DEFAULT_TIMEOUT):
        self.token = token or config.get_token()
        self.timeout = timeout

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def request(self, method, path, params=None, body=None):
        url = BASE_URL + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        payload = json.dumps(body).encode("utf-8") if body is not None else None

        for attempt in range(MAX_RETRIES):
            req = urllib.request.Request(
                url,
                data=payload,
                method=method,
                headers={
                    "Authorization": f"Bot {self.token}",
                    "User-Agent": USER_AGENT,
                    "Content-Type": "application/json",
                    "Content-Length": str(len(payload) if payload else 0),
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                status = exc.code

                if status == 429:
                    wait = _retry_after(raw, exc.headers)
                    if attempt == MAX_RETRIES - 1:
                        raise CliError(
                            "Rate limited by Discord and out of retries.",
                            remediation=f"Wait {wait:.1f}s and retry, or lower --limit.",
                            details={"retry_after": wait},
                        )
                    time.sleep(wait)
                    continue

                if status in (401, 403):
                    raise AuthError(
                        _error_message(raw, status),
                        remediation=(
                            "401 means the bot token is wrong or revoked. 403 means the bot "
                            "lacks permission on that channel, or is not in the server. Check "
                            "the bot's role permissions in Discord."
                        ),
                    )

                raise CliError(
                    _error_message(raw, status),
                    remediation=_remediation_for(status),
                    details={"status": status},
                )
            except urllib.error.URLError as exc:
                raise CliError(
                    f"Network error talking to Discord: {exc.reason}",
                    remediation="Check connectivity and retry.",
                )
            except TimeoutError:
                raise CliError(
                    f"Request to Discord timed out after {self.timeout}s.",
                    remediation="Retry, or lower --limit if you were fetching a lot.",
                )

        raise CliError("Exhausted retries without a response.")

    def get(self, path, params=None):
        return self.request("GET", path, params=params)

    # -- endpoint wrappers -------------------------------------------------

    def me(self):
        return self.get("/users/@me")

    def my_guilds(self):
        return self.get("/users/@me/guilds")

    def guild_channels(self, guild_id):
        return self.get(f"/guilds/{guild_id}/channels")

    def send_message(self, channel_id, content, reply_to=None):
        payload = {"content": content}
        if reply_to:
            # fail_if_not_exists=False degrades to a plain message rather than
            # erroring if the target was deleted between read and reply.
            payload["message_reference"] = {
                "message_id": reply_to,
                "fail_if_not_exists": False,
            }
        return self.request("POST", f"/channels/{channel_id}/messages", body=payload)

    def edit_message(self, channel_id, message_id, content):
        return self.request(
            "PATCH", f"/channels/{channel_id}/messages/{message_id}", body={"content": content}
        )

    def delete_message(self, channel_id, message_id):
        return self.request("DELETE", f"/channels/{channel_id}/messages/{message_id}")

    def get_message(self, channel_id, message_id):
        return self.get(f"/channels/{channel_id}/messages/{message_id}")

    def get_messages(self, channel_id, limit=50, before=None, after=None):
        params = {"limit": max(1, min(limit, 100))}
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        return self.get(f"/channels/{channel_id}/messages", params=params)

    def add_reaction(self, channel_id, message_id, emoji):
        encoded = urllib.parse.quote(emoji, safe="")
        return self.request(
            "PUT", f"/channels/{channel_id}/messages/{message_id}/reactions/{encoded}/@me"
        )


def _decode(raw):
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _retry_after(raw, headers):
    body = _decode(raw)
    if isinstance(body, dict) and "retry_after" in body:
        try:
            return float(body["retry_after"])
        except (TypeError, ValueError):
            pass
    header = headers.get("Retry-After") or headers.get("X-RateLimit-Reset-After")
    try:
        return float(header)
    except (TypeError, ValueError):
        return 1.0


def _error_message(raw, status):
    body = _decode(raw)
    if isinstance(body, dict):
        msg = body.get("message") or json.dumps(body)[:200]
        code = body.get("code")
        suffix = f" (code {code})" if code else ""
        return f"Discord API error {status}{suffix}: {msg}"
    return f"Discord returned HTTP {status}"


def _remediation_for(status):
    if status == 404:
        return (
            "The channel or message ID does not exist, or the bot cannot see it. "
            "Run 'discord channels' to list visible channels."
        )
    if status == 400:
        return "The request was malformed -- check the message content and IDs."
    return None

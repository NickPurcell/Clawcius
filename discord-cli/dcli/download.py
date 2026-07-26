"""Fetching attachments back off Discord's CDN and writing them to disk.

Two things earn this a module of its own rather than another method on Client.
Attachment URLs live on cdn.discordapp.com and media.discordapp.net rather than
discord.com, and they carry their own signature in the query string, so the bot
Authorization header is neither wanted nor sent -- handing credentials to a host
that does not need them is a habit worth not acquiring.

The second is that attachment filenames are supplied by whoever uploaded them.
Every one is therefore treated as hostile until it has been reduced to a bare
basename and proved to land inside the requested directory.
"""

import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .api import USER_AGENT
from .errors import CliError, ValidationError
from .render import human_size

# Attachments are served from these hosts. The list is a whitelist rather than
# decoration: it keeps 'discord download --url' from being a general-purpose
# fetcher pointed at whatever a message happens to contain.
CDN_HOSTS = ("cdn.discordapp.com", "media.discordapp.net")
# Discord also serves through per-shard and proxy subdomains of the two hosts
# above (images-ext-1.discordapp.net and friends), so the suffixes are needed.
# discord.com deliberately is NOT among them: it is the API host, not an
# attachment host, and widening the whitelist to cover it would buy nothing.
CDN_HOST_SUFFIXES = (".discordapp.com", ".discordapp.net")

# A ceiling so that one oversized attachment cannot fill the disk. 100 MiB is
# the largest a boost tier 3 server can produce, so this refuses nothing Discord
# would have allowed while still bounding the damage; --max-bytes moves it.
DEFAULT_MAX_BYTES = 100 * 1024 * 1024

CHUNK_BYTES = 64 * 1024
DEFAULT_TIMEOUT = 30.0

_UNSAFE_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def validate_url(url):
    """Accept only an https Discord CDN URL, query string intact.

    The query string is load-bearing: modern attachment links are signed with
    ex/is/hm parameters and are simply 404s or 403s without them.
    """
    raw = str(url or "").strip()
    if not raw:
        raise ValidationError(
            "No attachment URL given.",
            remediation="Pass --url with the 'url' field from a message's attachments.",
        )
    parts = urllib.parse.urlsplit(raw)
    if parts.scheme != "https":
        raise ValidationError(
            f"Attachment URLs must be https (got '{parts.scheme or raw}').",
            remediation="Copy the URL exactly as Discord returned it.",
        )
    host = (parts.hostname or "").lower()
    if host not in CDN_HOSTS and not host.endswith(CDN_HOST_SUFFIXES):
        raise ValidationError(
            f"'{host}' is not a Discord attachment host.",
            remediation=(
                "Attachments live on " + " or ".join(CDN_HOSTS) + ". This command "
                "deliberately refuses arbitrary URLs."
            ),
        )
    return raw


def filename_from_url(url):
    """The last path segment, with the signed query string discarded."""
    path = urllib.parse.urlsplit(str(url)).path
    return safe_filename(urllib.parse.unquote(path.rsplit("/", 1)[-1]))


def safe_filename(raw):
    """Reduce an attachment filename to a bare, writable basename.

    Directory components are stripped rather than rejected, because a name like
    'a/b.png' is more likely careless than hostile; '.' and '..' are rejected
    outright, since neither has an innocent reading.
    """
    name = _UNSAFE_CHARS.sub("", str(raw or "").strip())
    name = name.replace("\\", "/")  # a Windows-style path is still a path
    name = name.rsplit("/", 1)[-1].strip()
    if name in ("", ".", ".."):
        raise ValidationError(
            f"Refusing to write an attachment named '{raw}'.",
            remediation="Pass --out with a directory and rename the file yourself afterwards.",
        )
    if os.path.isabs(name) or os.sep in name or (os.altsep and os.altsep in name):
        raise ValidationError(
            f"Refusing to write an attachment named '{raw}'.",
            remediation="The filename still contains a path separator after sanitising.",
        )
    return name


def ensure_dir(out):
    """Resolve --out, creating it if need be."""
    directory = Path(str(out or ".")).expanduser()
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ValidationError(
            f"Could not create output directory {directory}: {exc}",
            remediation="Pass --out with a directory you can write to.",
        )
    if not os.access(directory, os.W_OK):
        raise ValidationError(
            f"Output directory is not writable: {directory}",
            remediation="Pass --out with a directory you can write to.",
        )
    return directory.resolve()


def target_path(out_dir, filename, overwrite=False):
    """Where a given attachment may be written, or an error explaining why not.

    Resolving the joined path and insisting its parent is still the output
    directory catches traversal and a symlink planted in the output directory
    alike; neither may be used to write outside where the caller asked.
    """
    directory = Path(out_dir).expanduser().resolve()
    name = safe_filename(filename)
    target = (directory / name).resolve()
    if target.parent != directory:
        raise ValidationError(
            f"Refusing to write '{filename}' outside {directory}.",
            remediation=(
                "The name resolves outside the output directory, via traversal or a "
                "symlink. Download to an empty directory instead."
            ),
        )
    if target.exists() and not overwrite:
        raise ValidationError(
            f"{target} already exists.",
            remediation="Pass --overwrite to replace it, or --out to write elsewhere.",
        )
    return target


def fetch(
    url,
    out_dir,
    filename=None,
    max_bytes=DEFAULT_MAX_BYTES,
    timeout=DEFAULT_TIMEOUT,
    overwrite=False,
):
    """Download one attachment and return a record of what landed where."""
    url = validate_url(url)
    target = target_path(out_dir, filename or filename_from_url(url), overwrite=overwrite)

    # No Authorization header on purpose: the CDN authenticates the signed URL,
    # not the bot, and sending the token here would leak it to a host that has
    # no business with it.
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            declared = _declared_length(resp.headers.get("Content-Length"))
            if declared is not None and declared > max_bytes:
                raise CliError(
                    f"Attachment is {human_size(declared)}, over the "
                    f"{human_size(max_bytes)} download cap.",
                    remediation="Raise --max-bytes if you genuinely want the whole file.",
                    details={"size": declared, "max_bytes": max_bytes, "url": url},
                )
            content_type = _content_type(resp.headers.get("Content-Type"))
            written = _stream_to_disk(resp, target, max_bytes, url)
    except urllib.error.HTTPError as exc:
        raise CliError(
            f"Discord CDN returned HTTP {exc.code} for the attachment.",
            remediation=_remediation_for(exc.code),
            details={"status": exc.code, "url": url},
        )
    except urllib.error.URLError as exc:
        raise CliError(
            f"Network error fetching the attachment: {exc.reason}",
            remediation="Check connectivity to " + " / ".join(CDN_HOSTS) + " and retry.",
        )
    except TimeoutError:
        raise CliError(
            f"Fetching the attachment timed out after {timeout}s.",
            remediation="Retry; large attachments over a slow link may need more time.",
        )

    return {
        "filename": target.name,
        "path": str(target),
        "size": written,
        "content_type": content_type,
        "url": url,
    }


def _stream_to_disk(resp, target, max_bytes, url):
    """Stream to a temporary file in the target directory, then rename.

    Downloading through a temporary means an aborted or oversized fetch leaves
    nothing behind that could be mistaken for a complete file.
    """
    handle = tempfile.NamedTemporaryFile(
        dir=str(target.parent), prefix=".dcli-", suffix=".part", delete=False
    )
    tmp = Path(handle.name)
    total = 0
    try:
        with handle:
            while True:
                chunk = resp.read(CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise CliError(
                        f"Attachment exceeds the {human_size(max_bytes)} download cap "
                        f"(stopped after {human_size(total)}).",
                        remediation="Raise --max-bytes if you genuinely want the whole file.",
                        details={"max_bytes": max_bytes, "url": url},
                    )
                handle.write(chunk)
        # NamedTemporaryFile is deliberately 0600; a downloaded file should look
        # like any other file the caller created, so honour their umask instead.
        os.chmod(tmp, _default_file_mode())
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return total


def _default_file_mode():
    current = os.umask(0)
    os.umask(current)
    return 0o666 & ~current


def _declared_length(header):
    try:
        return int(header)
    except (TypeError, ValueError):
        return None


def _content_type(header):
    if not header:
        return None
    return header.split(";", 1)[0].strip() or None


def _remediation_for(status):
    if status in (403, 404):
        return (
            "Attachment URLs are signed and expire -- the 'ex' parameter is the expiry. "
            "Re-read the message to obtain a fresh URL, or use --channel/--message so "
            "the URL is fetched at download time."
        )
    if status == 416:
        return "The CDN rejected the range requested; retry the whole file."
    return "Retry; if it persists, re-read the message for a current URL."

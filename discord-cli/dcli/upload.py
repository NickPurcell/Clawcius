"""Attachment uploads: validating local files and hand-rolling multipart bodies.

Standard library only, as everywhere else in this tool, so the multipart body is
assembled here rather than delegated to a third-party HTTP library. The whole
payload is held in memory, which the size ceiling below makes comfortable and
the boundary check makes necessary: the boundary cannot be chosen until the file
bytes are available to check it against.

Files are read and measured before any network call, on the same bargain the
rest of the tool strikes with snowflake validation -- a bad path should cost one
fast turn, not a round trip and an opaque HTTP 400.
"""

import json
import mimetypes
import os
import re
import secrets
from pathlib import Path

from .errors import CliError, ValidationError
from .render import human_size

# Discord accepts at most ten attachments on a single message.
MAX_ATTACHMENTS = 10

# The per-message upload ceiling belongs to the server, not the account: 10 MiB
# with no boosts, 50 MiB at boost tier 2, 100 MiB at tier 3. Nothing the bot can
# cheaply read tells us which applies, and finding out the hard way costs a full
# upload followed by an HTTP 413. So we assume the floor and let
# --max-upload-bytes raise it on a server known to be boosted.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

DEFAULT_CONTENT_TYPE = "application/octet-stream"

# A boundary that also occurs inside an attachment would silently corrupt the
# request. With binary payloads that is a real possibility rather than a
# theoretical one, so the boundary is checked against every byte we are about to
# send and redrawn if it collides.
BOUNDARY_ATTEMPTS = 8
BOUNDARY_BYTES = 24

# Control characters, quotes and backslashes would break out of the quoted
# filename in the Content-Disposition header, so they are replaced rather than
# escaped -- an upload with a mangled name beats a malformed request.
_HEADER_UNSAFE = re.compile(r'[\x00-\x1f\x7f"\\]')


def load_files(paths, max_total_bytes=MAX_UPLOAD_BYTES):
    """Validate and read every --file argument.

    Returns a list of dicts carrying 'filename', 'content_type', 'size' and the
    raw 'data', in the order given on the command line.
    """
    paths = list(paths or [])
    if not paths:
        return []
    if len(paths) > MAX_ATTACHMENTS:
        raise ValidationError(
            f"{len(paths)} files given; Discord allows {MAX_ATTACHMENTS} per message.",
            remediation="Send the rest in a follow-up message.",
        )

    files, total = [], 0
    for raw in paths:
        path = Path(raw).expanduser()
        if not path.exists():
            raise ValidationError(
                f"No such file: {path}",
                remediation="Check the path. --file takes a local path, not a URL.",
            )
        if not path.is_file():
            raise ValidationError(
                f"Not a regular file: {path}",
                remediation=(
                    "--file takes one ordinary file per flag; directories, sockets and "
                    "devices cannot be uploaded. Repeat --file to attach several."
                ),
            )
        if not os.access(path, os.R_OK):
            raise ValidationError(
                f"Not readable: {path}",
                remediation="Check the file's permissions and the ownership of its directory.",
            )

        size = path.stat().st_size
        if size == 0:
            raise ValidationError(
                f"File is empty: {path}",
                remediation="Discord rejects zero-byte attachments. Send some content.",
            )
        total += size
        if total > max_total_bytes:
            raise ValidationError(
                f"Attachments total {human_size(total)}, over the "
                f"{human_size(max_total_bytes)} ceiling (reached at {path}).",
                remediation=(
                    "Discord's per-message limit is 10 MiB on an unboosted server, 50 MiB at "
                    "boost tier 2 and 100 MiB at tier 3. Compress the file, attach fewer at "
                    "once, or raise --max-upload-bytes if the server is boosted."
                ),
            )

        try:
            data = path.read_bytes()
        except OSError as exc:
            raise ValidationError(
                f"Could not read {path}: {exc}",
                remediation="Check the file's permissions and that it still exists.",
            )

        files.append(
            {
                "path": str(path),
                "filename": part_filename(path.name),
                "content_type": guess_content_type(path),
                "size": len(data),
                "data": data,
            }
        )
    return files


def part_filename(name):
    """Reduce a name to something safe to sit inside a quoted header."""
    base = os.path.basename(str(name).replace("\\", "/"))
    cleaned = _HEADER_UNSAFE.sub("_", base).strip()
    return cleaned or "attachment"


def guess_content_type(path):
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or DEFAULT_CONTENT_TYPE


def attachments_metadata(files):
    """The 'attachments' array Discord expects alongside the files[N] parts.

    The id is positional: files[0] is described by the entry with id 0. This is
    also the filename Discord displays, so it must match the part's filename.
    """
    return [{"id": index, "filename": item["filename"]} for index, item in enumerate(files)]


def build_multipart(payload, files):
    """Encode a JSON payload plus files as multipart/form-data.

    Returns (body_bytes, content_type_header). The modern shape Discord expects
    is one 'payload_json' part carrying the whole message object, and one
    'files[N]' part per attachment.
    """
    payload_json = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    boundary = _pick_boundary([payload_json] + [item["data"] for item in files])
    marker = ("--" + boundary).encode("ascii")

    chunks = [
        marker,
        b"\r\n",
        b'Content-Disposition: form-data; name="payload_json"\r\n',
        b"Content-Type: application/json\r\n\r\n",
        payload_json,
        b"\r\n",
    ]
    for index, item in enumerate(files):
        name = item["filename"]
        content_type = item["content_type"]
        disposition = (
            f'Content-Disposition: form-data; name="files[{index}]"; filename="{name}"\r\n'
        )
        chunks.append(marker)
        chunks.append(b"\r\n")
        chunks.append(disposition.encode("utf-8"))
        chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
        chunks.append(item["data"])
        chunks.append(b"\r\n")
    chunks.append(marker + b"--\r\n")

    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _pick_boundary(blobs):
    """A random boundary that provably does not occur in what we are sending."""
    for _ in range(BOUNDARY_ATTEMPTS):
        candidate = "dcli" + secrets.token_hex(BOUNDARY_BYTES)
        needle = candidate.encode("ascii")
        if not any(needle in blob for blob in blobs):
            return candidate
    raise CliError(
        "Could not find a multipart boundary absent from the payload.",
        remediation=(
            "This is astronomically unlikely with random boundaries. Retry; if it "
            "recurs, the input is not what it appears to be."
        ),
    )

"""Capture an iPhone's myQ OAuth token without logging secret values."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import parse_qs

from mitmproxy import ctx, http


TOKEN_HOST = "partner-identity.myq-cloud.com"
TOKEN_PATH = "/connect/token"
TOKEN_FIELDS = ("access_token", "refresh_token", "expires_in", "token_type", "scope")
IOS_CLIENT_ID = "IOS_CGI_MYQ"


def _write_private_json(destination: Path, payload: dict[str, object]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def response(flow: http.HTTPFlow) -> None:
    if flow.request.pretty_host.lower() != TOKEN_HOST:
        return
    if flow.request.path.split("?", 1)[0] != TOKEN_PATH or flow.response.status_code != 200:
        return
    expected_phone = os.environ.get("MYQ_IPHONE_IP")
    peer = flow.client_conn.peername
    if expected_phone and (not peer or peer[0] != expected_phone):
        return
    request_fields = parse_qs(flow.request.get_text(strict=False), keep_blank_values=True)
    if request_fields.get("client_id", [None])[-1] != IOS_CLIENT_ID:
        return
    try:
        source = json.loads(flow.response.get_text(strict=False))
    except (TypeError, ValueError):
        return
    if not isinstance(source, dict) or not isinstance(source.get("refresh_token"), str):
        return
    token = {field: source[field] for field in TOKEN_FIELDS if field in source}
    token["client_id"] = IOS_CLIENT_ID
    destination_value = os.environ.get("MYQ_TOKEN_OUT")
    if not destination_value:
        ctx.log.error("MYQ_TOKEN_OUT is unset; token was not written")
        return
    destination = Path(destination_value).expanduser().resolve()
    _write_private_json(destination, token)
    ctx.log.info(f"Captured iOS myQ refresh token to {destination} (values not logged)")

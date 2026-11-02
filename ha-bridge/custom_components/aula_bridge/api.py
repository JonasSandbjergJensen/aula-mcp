"""Authenticated gateway client. Credentials never go to the dashboard."""
import asyncio
from urllib.parse import urlsplit
from aiohttp import ClientError


class BridgeError(Exception):
    """An upstream connection or authentication error."""


def validate_url(value):
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid_url")
    if parsed.path not in ("", "/") or not parsed.hostname:
        raise ValueError("invalid_url")
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
    ):
        raise ValueError("https_required")
    return value.rstrip("/")


class BridgeApi:
    def __init__(self, session, url, token):
        self.session = session
        self.url = validate_url(url)
        self._token = token

    async def request(self, path, body=None, binary=False):
        try:
            async with asyncio.timeout(300):
                async with self.session.request(
                    "POST" if body is not None else "GET",
                    self.url + "/api/v1/" + path,
                    headers={"Authorization": "Bearer " + self._token},
                    json=body, allow_redirects=False,
                ) as response:
                    if response.status == 401:
                        raise BridgeError("invalid_auth")
                    if response.status != 200:
                        raise BridgeError("cannot_connect")
                    limit = 50 * 1024 * 1024 if binary else 20 * 1024 * 1024
                    data = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        data.extend(chunk)
                        if len(data) > limit:
                            raise BridgeError("response_too_large")
                    if binary:
                        return bytes(data), response.headers.get("Content-Disposition", "attachment")
                    import json
                    return json.loads(data)
        except (ClientError, TimeoutError, ValueError) as err:
            raise BridgeError("cannot_connect") from err

    async def call(self, name, arguments=None):
        return await self.request("call", {"name": name, "arguments": arguments or {}})

#!/usr/bin/env python3
"""Security-hardened HTTP runner for Herdr API Client."""

from __future__ import annotations

import argparse
import http.client
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
ALLOWED_SCHEMES = {"http", "https"}
MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MiB cap
DEFAULT_TIMEOUT_SEC = 15.0
MAX_TIMEOUT_SEC = 60.0


class UnsafeSchemeError(ValueError):
    """Raised when an initial or redirected URL uses a non-HTTP(S) scheme."""


def validate_http_url(raw_url: str) -> str:
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise ValueError("URL must not be empty")
    url = raw_url.strip()
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in url):
        raise ValueError("URL contains invalid control characters")
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise UnsafeSchemeError(f"Blocked URL scheme '{scheme}': only http and https are allowed")
    if not parsed.netloc:
        raise ValueError("URL must include a valid host")
    return url


def sanitize_headers(raw_headers: dict | None) -> dict[str, str]:
    if not isinstance(raw_headers, dict):
        return {}
    cleaned: dict[str, str] = {}
    for k, v in raw_headers.items():
        key = str(k).strip()
        val = "" if v is None else str(v)
        if not key:
            continue
        if any(ch in key for ch in ("\r", "\n", "\x00")) or any(ch in val for ch in ("\r", "\n", "\x00")):
            raise ValueError(f"Header '{key}' contains invalid newline or null characters")
        cleaned[key] = val
    return cleaned


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Ensure every HTTP redirect stays on http/https and never drops to file:// or custom schemes."""

    def http_error_302(self, req, fp, code, msg, headers):
        target = headers.get("location") or headers.get("uri")
        if target is not None:
            resolved = urllib.parse.urljoin(req.full_url, target)
            try:
                validate_http_url(resolved)
            except Exception:
                try:
                    fp.close()
                except Exception:
                    pass
                raise
        return super().http_error_302(req, fp, code, msg, headers)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        resolved = urllib.parse.urljoin(req.full_url, newurl)
        try:
            validate_http_url(resolved)
        except Exception:
            try:
                fp.close()
            except Exception:
                pass
            raise
        return super().redirect_request(req, fp, code, msg, headers, resolved)


def format_body(raw_bytes: bytes, charset: str | None) -> tuple[str, bool]:
    if not raw_bytes:
        return "", False
    enc = charset or "utf-8"
    try:
        text = raw_bytes.decode(enc, errors="replace")
    except LookupError:
        text = raw_bytes.decode("utf-8", errors="replace")

    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            parsed = json.loads(text)
            return json.dumps(parsed, indent=2, ensure_ascii=False), True
        except Exception:
            pass
    return text, False


def execute_request(payload: dict) -> dict:
    method = str(payload.get("method") or "GET").upper().strip()
    if method not in ALLOWED_METHODS:
        return {
            "ok": False,
            "status": 0,
            "statusText": "Invalid Method",
            "elapsedMs": 0,
            "sizeBytes": 0,
            "headers": {},
            "body": "",
            "isJson": False,
            "truncated": False,
            "error": f"Unsupported HTTP method: {method}",
        }

    try:
        url = validate_http_url(str(payload.get("url") or ""))
        headers = sanitize_headers(payload.get("headers"))
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "statusText": "Blocked",
            "elapsedMs": 0,
            "sizeBytes": 0,
            "headers": {},
            "body": "",
            "isJson": False,
            "truncated": False,
            "error": str(exc),
        }

    raw_timeout = payload.get("timeoutSec", DEFAULT_TIMEOUT_SEC)
    try:
        timeout = max(1.0, min(MAX_TIMEOUT_SEC, float(raw_timeout)))
    except Exception:
        timeout = DEFAULT_TIMEOUT_SEC

    verify_ssl = payload.get("verifySsl", True) is not False
    ssl_ctx = ssl.create_default_context() if verify_ssl else ssl._create_unverified_context()

    body_data: bytes | None = None
    raw_body = payload.get("body")
    if method not in ("GET", "HEAD") and isinstance(raw_body, str) and raw_body != "":
        body_data = raw_body.encode("utf-8")

    if "User-Agent" not in {k.title(): v for k, v in headers.items()}:
        headers["User-Agent"] = "Herdr-API-Client/1.0"

    req = urllib.request.Request(url=url, data=body_data, headers=headers, method=method)
    opener = urllib.request.build_opener(
        SafeRedirectHandler(),
        urllib.request.HTTPSHandler(context=ssl_ctx),
    )

    started = time.perf_counter()
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw_chunk = resp.read(MAX_RESPONSE_BYTES + 1)
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            truncated = len(raw_chunk) > MAX_RESPONSE_BYTES
            data = raw_chunk[:MAX_RESPONSE_BYTES]
            resp_headers = {k: v for k, v in resp.headers.items()}
            charset = resp.headers.get_content_charset()
            formatted, is_json = format_body(data, charset)
            status = int(getattr(resp, "status", 200))
            reason = str(getattr(resp, "reason", "") or http.client.responses.get(status, ""))
            return {
                "ok": True,
                "status": status,
                "statusText": reason,
                "elapsedMs": elapsed_ms,
                "sizeBytes": len(raw_chunk) if not truncated else MAX_RESPONSE_BYTES,
                "headers": resp_headers,
                "body": formatted,
                "isJson": is_json,
                "truncated": truncated,
                "error": None,
            }
    except UnsafeSchemeError as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "status": 0,
            "statusText": "Blocked",
            "elapsedMs": elapsed_ms,
            "sizeBytes": 0,
            "headers": {},
            "body": "",
            "isJson": False,
            "truncated": False,
            "error": str(exc),
        }
    except urllib.error.HTTPError as err:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        try:
            raw_chunk = err.read(MAX_RESPONSE_BYTES + 1)
        except Exception:
            raw_chunk = b""
        truncated = len(raw_chunk) > MAX_RESPONSE_BYTES
        data = raw_chunk[:MAX_RESPONSE_BYTES]
        resp_headers = {k: v for k, v in err.headers.items()} if err.headers else {}
        charset = err.headers.get_content_charset() if err.headers else None
        formatted, is_json = format_body(data, charset)
        status = int(err.code)
        reason = str(err.reason or http.client.responses.get(status, ""))
        return {
            "ok": True,
            "status": status,
            "statusText": reason,
            "elapsedMs": elapsed_ms,
            "sizeBytes": len(data),
            "headers": resp_headers,
            "body": formatted,
            "isJson": is_json,
            "truncated": truncated,
            "error": None,
        }
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "ok": False,
            "status": 0,
            "statusText": "Network Error",
            "elapsedMs": elapsed_ms,
            "sizeBytes": 0,
            "headers": {},
            "body": "",
            "isJson": False,
            "truncated": False,
            "error": str(exc),
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Herdr API Client HTTP Runner")
    parser.add_argument("--payload", required=True, help="JSON request payload")
    args = parser.parse_args(argv)

    try:
        payload = json.loads(args.payload)
        if not isinstance(payload, dict):
            raise ValueError("Payload must be a JSON object")
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": 0,
                    "statusText": "Invalid Payload",
                    "elapsedMs": 0,
                    "sizeBytes": 0,
                    "headers": {},
                    "body": "",
                    "isJson": False,
                    "truncated": False,
                    "error": f"Invalid payload JSON: {exc}",
                }
            )
        )
        return 0

    result = execute_request(payload)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

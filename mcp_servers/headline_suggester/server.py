#!/usr/bin/env python3
"""
Tiny MCP server for proposing note headlines.

Transport:
  - JSON-RPC 2.0 over stdio using MCP/LSP-style Content-Length framing.
  - Also accepts newline-delimited JSON for simple manual smoke tests.

Providers:
  - HEADLINE_PROVIDER=ollama (default): local Ollama HTTP API
  - HEADLINE_PROVIDER=openai: OpenAI-compatible chat completions API
  - HEADLINE_PROVIDER=heuristic: dependency-free deterministic fallback
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any


SERVER_NAME = "orgarhythmus-headline-suggester"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2024-11-05"

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "qwen2.5:7b"
DEFAULT_OPENAI_MODEL = "gpt-4.1-mini"


TOOL_NAME = "propose_note_headline"
TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {
            "type": "string",
            "description": "The note description/body. HTML is accepted and will be converted to plain text.",
        },
        "currentHeadline": {
            "type": "string",
            "description": "Optional current headline/title, used only as context.",
        },
        "style": {
            "type": "string",
            "description": "Optional style hint, e.g. concise, action-oriented, project-like, calm.",
        },
        "maxWords": {
            "type": "integer",
            "minimum": 2,
            "maximum": 14,
            "description": "Maximum headline words. Defaults to 7.",
        },
    },
    "required": ["description"],
    "additionalProperties": False,
}


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def clean_note_text(text: str, limit: int = 6000) -> str:
    text = html.unescape(text or "")
    text = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def clamp_max_words(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 7
    return max(2, min(14, parsed))


def trim_headline(text: str, max_words: int) -> str:
    text = re.sub(r"^[\"'“”‘’\s]+|[\"'“”‘’\s]+$", "", text or "")
    text = re.sub(r"(?i)^(headline|title)\s*:\s*", "", text).strip()
    text = re.sub(r"\s+", " ", text)
    text = text.rstrip(".")
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words])
    return text[:90].strip() or "Untitled Note"


def build_prompt(description: str, current_headline: str = "", style: str = "", max_words: int = 7) -> str:
    current = f"\nCurrent headline: {current_headline.strip()}" if current_headline.strip() else ""
    style_hint = f"\nStyle hint: {style.strip()}" if style.strip() else ""
    return (
        "You suggest concise, useful headlines for personal project notes.\n"
        "Return exactly one headline and nothing else.\n"
        f"Constraints: maximum {max_words} words, no quotation marks, no trailing period."
        f"{current}{style_hint}\n\n"
        f"Note description:\n{description.strip()}"
    )


def heuristic_headline(description: str, max_words: int) -> str:
    text = clean_note_text(description)
    if not text:
        return "Untitled Note"

    first_sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0]
    candidate = first_sentence
    candidate = re.sub(r"(?i)^(todo|note|idea|task|project)\s*[:\-]\s*", "", candidate).strip()
    words = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9'_-]*", candidate)
    if not words:
        return "Untitled Note"

    stop = {
        "the", "a", "an", "and", "or", "but", "with", "for", "from", "that", "this",
        "there", "their", "into", "onto", "about", "because", "should", "would", "could",
        "need", "needs", "make", "made", "have", "has", "was", "were", "are", "is",
    }
    trimmed = []
    for word in words:
        if len(trimmed) >= max_words:
            break
        if not trimmed and word.lower() in stop:
            continue
        trimmed.append(word)
    if not trimmed:
        trimmed = words[:max_words]

    return trim_headline(" ".join(trimmed).title(), max_words)


def http_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None, timeout: float = 20.0) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    request = urllib.request.Request(url, data=body, headers=request_headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def ollama_headline(description: str, current_headline: str, style: str, max_words: int) -> str:
    base_url = os.environ.get("OLLAMA_BASE_URL", DEFAULT_OLLAMA_URL).rstrip("/")
    model = os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
    prompt = build_prompt(description, current_headline, style, max_words)
    response = http_json(
        f"{base_url}/api/generate",
        {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.2,
                "num_predict": 32,
            },
        },
        timeout=float(os.environ.get("HEADLINE_TIMEOUT_SECONDS", "90")),
    )
    return trim_headline(str(response.get("response", "")), max_words)


def openai_headline(description: str, current_headline: str, style: str, max_words: int) -> str:
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("HEADLINE_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY or HEADLINE_API_KEY is required for HEADLINE_PROVIDER=openai")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    prompt = build_prompt(description, current_headline, style, max_words)
    response = http_json(
        f"{base_url}/chat/completions",
        {
            "model": model,
            "messages": [
                {"role": "system", "content": "You write concise note headlines. Output exactly one headline."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": 32,
        },
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=float(os.environ.get("HEADLINE_TIMEOUT_SECONDS", "30")),
    )
    return trim_headline(response["choices"][0]["message"]["content"], max_words)


def propose_headline(arguments: dict[str, Any]) -> dict[str, Any]:
    description = clean_note_text(str(arguments.get("description", "")))
    if not description:
        raise JsonRpcError(-32602, "description must not be empty")

    current_headline = clean_note_text(str(arguments.get("currentHeadline", "")), limit=500)
    style = clean_note_text(str(arguments.get("style", "")), limit=300)
    max_words = clamp_max_words(arguments.get("maxWords"))
    provider = os.environ.get("HEADLINE_PROVIDER", "ollama").strip().lower()

    provider_error = None
    try:
        if provider == "ollama":
            headline = ollama_headline(description, current_headline, style, max_words)
        elif provider == "openai":
            headline = openai_headline(description, current_headline, style, max_words)
        elif provider == "heuristic":
            headline = heuristic_headline(description, max_words)
        else:
            raise RuntimeError(f"Unknown HEADLINE_PROVIDER={provider!r}")
    except Exception as exc:  # local-first tool should remain usable without a model daemon
        provider_error = str(exc)
        headline = heuristic_headline(description, max_words)
        provider = "heuristic-fallback"

    return {
        "headline": trim_headline(headline, max_words),
        "provider": provider,
        "providerError": provider_error,
    }


def response(message_id: Any, result: Any = None, error: JsonRpcError | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": message_id}
    if error:
        error_payload: dict[str, Any] = {"code": error.code, "message": error.message}
        if error.data is not None:
            error_payload["data"] = error.data
        payload["error"] = error_payload
    else:
        payload["result"] = result
    return payload


def handle_request(message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    message_id = message.get("id")
    params = message.get("params") or {}

    if method == "notifications/initialized":
        return None

    try:
        if method == "initialize":
            return response(message_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            })
        if method == "ping":
            return response(message_id, {})
        if method == "tools/list":
            return response(message_id, {
                "tools": [{
                    "name": TOOL_NAME,
                    "description": "Propose a concise headline for a note description. The caller can then show it for acceptance.",
                    "inputSchema": TOOL_SCHEMA,
                }]
            })
        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}
            if name != TOOL_NAME:
                raise JsonRpcError(-32601, f"Unknown tool: {name}")
            result = propose_headline(arguments)
            return response(message_id, {
                "content": [{
                    "type": "text",
                    "text": result["headline"],
                }],
                "structuredContent": result,
                "isError": False,
            })
        raise JsonRpcError(-32601, f"Unknown method: {method}")
    except JsonRpcError as exc:
        return response(message_id, error=exc)
    except Exception as exc:
        return response(message_id, error=JsonRpcError(-32603, "Internal error", str(exc)))


def encode_message(message: dict[str, Any]) -> bytes:
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


def write_message(message: dict[str, Any]) -> None:
    sys.stdout.buffer.write(encode_message(message))
    sys.stdout.buffer.flush()


def read_content_length_message(buffer: bytes) -> tuple[dict[str, Any] | None, bytes]:
    header_end = buffer.find(b"\r\n\r\n")
    separator_len = 4
    if header_end < 0:
        header_end = buffer.find(b"\n\n")
        separator_len = 2
    if header_end < 0:
        return None, buffer

    headers = buffer[:header_end].decode("ascii", errors="replace").splitlines()
    content_length = None
    for header in headers:
        name, _, value = header.partition(":")
        if name.lower() == "content-length":
            content_length = int(value.strip())
            break
    if content_length is None:
        raise RuntimeError("Missing Content-Length header")

    body_start = header_end + separator_len
    body_end = body_start + content_length
    if len(buffer) < body_end:
        return None, buffer
    return json.loads(buffer[body_start:body_end].decode("utf-8")), buffer[body_end:]


def serve() -> None:
    buffer = b""
    while True:
        chunk = sys.stdin.buffer.read1(4096)
        if not chunk:
            break
        buffer += chunk

        # Manual smoke-test mode: one JSON object per line.
        if not buffer.startswith(b"Content-Length:") and b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.strip():
                continue
            outgoing = handle_request(json.loads(line.decode("utf-8")))
            if outgoing is not None:
                sys.stdout.write(json.dumps(outgoing, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            continue

        while buffer.startswith(b"Content-Length:"):
            incoming, buffer = read_content_length_message(buffer)
            if incoming is None:
                break
            outgoing = handle_request(incoming)
            if outgoing is not None:
                write_message(outgoing)


if __name__ == "__main__":
    serve()

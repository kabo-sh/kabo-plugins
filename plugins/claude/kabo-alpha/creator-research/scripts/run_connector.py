#!/usr/bin/env python3
"""Run a V1 Creator data Connector through one secret-safe product interface."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = PLUGIN_ROOT / "config" / "connectors.v1.json"
KNOWN_SECRET_NAMES = {
    "YOUTUBE_API_KEY",
    "TUBELAB_API_KEY",
    "GEMINI_API_KEY",
    "SCRAPECREATORS_API_KEY",
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
}
FORBIDDEN_PARAM_FRAGMENTS = ("api_key", "apikey", "token", "secret", "password", "credential")
STATUS_EXIT = {
    "completed": 0,
    "completed_partial": 0,
    "blocked_setup": 3,
    "feature_gated": 4,
    "unsupported": 4,
    "failed": 5,
}


class ConnectorError(RuntimeError):
    status = "failed"

    def __init__(self, message: str, *, raw: bytes = b"", request: dict | None = None):
        super().__init__(message)
        self.raw = raw
        self.request = request or {}


class MissingPrerequisite(ConnectorError):
    status = "blocked_setup"


class UnsupportedOperation(ConnectorError):
    status = "unsupported"


@dataclass
class AdapterResult:
    provider: str
    data: Any
    raw: bytes
    provider_request: dict
    status: str = "completed"
    limitations: list[str] = field(default_factory=list)
    raw_suffix: str = ".json"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def require_text(params: dict, name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"params.{name} must be a non-empty string")
    return value.strip()


def optional_int(params: dict, name: str, default: int, minimum: int, maximum: int) -> int:
    value = params.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"params.{name} must be an integer in {minimum}..{maximum}")
    return value


def ensure_no_secret_params(value: Any, path: str = "params") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).casefold().replace("-", "_")
            if any(fragment in lowered for fragment in FORBIDDEN_PARAM_FRAGMENTS):
                raise ValueError(f"{path}.{key} is forbidden; inject credentials through the host environment")
            ensure_no_secret_params(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            ensure_no_secret_params(child, f"{path}[{index}]")


def parse_request(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    allowed = {"request_id", "connector_id", "operation", "params", "budget"}
    extra = set(payload) - allowed
    if extra:
        raise ValueError("unsupported request fields: " + ", ".join(sorted(extra)))
    for name in ("request_id", "connector_id", "operation"):
        require_text(payload, name)
    params = payload.get("params", {})
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    ensure_no_secret_params(params)
    budget = payload.get("budget", {"max_provider_requests": 1})
    if not isinstance(budget, dict) or set(budget) - {"max_provider_requests", "timeout_seconds", "max_response_bytes"}:
        raise ValueError("budget accepts only max_provider_requests, timeout_seconds and max_response_bytes")
    max_requests = budget.get("max_provider_requests", 1)
    if max_requests != 1:
        raise ValueError("V1 atomic Connector calls require budget.max_provider_requests=1")
    timeout = budget.get("timeout_seconds", 90)
    max_bytes = budget.get("max_response_bytes", 20_000_000)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 900:
        raise ValueError("budget.timeout_seconds must be 1..900")
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 1_024 <= max_bytes <= 50_000_000:
        raise ValueError("budget.max_response_bytes must be 1024..50000000")
    payload["params"] = params
    payload["budget"] = {"max_provider_requests": 1, "timeout_seconds": timeout, "max_response_bytes": max_bytes}
    return payload


def secret_value(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    for raw_path in os.environ.get("CREATOR_CONNECTOR_ENV_FILES", "").split(os.pathsep):
        if not raw_path:
            continue
        path = Path(raw_path).expanduser().resolve()
        if not path.is_file():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            key, separator, candidate = line.partition("=")
            if separator and key.strip() == name:
                candidate = candidate.strip().strip("'\"")
                if candidate:
                    return candidate
    raise MissingPrerequisite(f"missing host secret: {name}")


def executable(env_name: str, default: str) -> str:
    configured = os.environ.get(env_name)
    if configured:
        path = Path(configured).expanduser().resolve()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        raise MissingPrerequisite(f"{env_name} does not point to an executable file")
    found = shutil.which(default)
    if not found:
        raise MissingPrerequisite(f"missing runtime binary: {default}; configure {env_name}")
    return found


def child_env(required_secret: str) -> tuple[dict[str, str], list[str]]:
    required_value = secret_value(required_secret)
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        "HOME": os.environ.get("HOME", "/tmp"),
        required_secret: required_value,
    }
    return env, known_secret_values()


def known_secret_values() -> list[str]:
    values = []
    for name in KNOWN_SECRET_NAMES:
        try:
            values.append(secret_value(name))
        except MissingPrerequisite:
            pass
    return [value for value in values if value]


def redact(value: bytes, secrets: list[str]) -> bytes:
    for secret in secrets:
        value = value.replace(secret.encode("utf-8"), b"[REDACTED_SECRET]")
        encoded = urllib.parse.quote(secret).encode("utf-8")
        value = value.replace(encoded, b"[REDACTED_SECRET]")
    return value


def parse_json_bytes(raw: bytes, provider: str) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConnectorError(f"{provider} returned non-JSON output: {error}", raw=raw) from error


def run_json_command(
    argv: list[str], required_secret: str, timeout: int, max_bytes: int, provider: str
) -> tuple[Any, bytes, dict]:
    env, secrets = child_env(required_secret)
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )
    duration_ms = round((time.monotonic() - started) * 1000, 3)
    stdout = redact(completed.stdout, secrets)
    stderr = redact(completed.stderr, secrets)
    request_record = {
        "transport": "subprocess",
        "command": argv,
        "exit_code": completed.returncode,
        "duration_ms": duration_ms,
        "credential_values_recorded": False,
    }
    if len(stdout) > max_bytes:
        raise ConnectorError(f"{provider} response exceeded max_response_bytes", request=request_record)
    if completed.returncode != 0:
        message = stderr.decode("utf-8", "replace").strip() or f"exit {completed.returncode}"
        raise ConnectorError(f"{provider} command failed: {message[:1000]}", raw=stdout, request=request_record)
    return parse_json_bytes(stdout, provider), stdout, request_record


def run_bytes_command(
    argv: list[str], timeout: int, max_bytes: int, provider: str,
    *, required_secret: str | None = None, extra_env: dict[str, str] | None = None,
) -> tuple[bytes, bytes, dict]:
    if required_secret:
        env, secrets = child_env(required_secret)
    else:
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
            "HOME": os.environ.get("HOME", "/tmp"),
        }
        secrets = known_secret_values()
    env.update(extra_env or {})
    started = time.monotonic()
    completed = subprocess.run(
        argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False, timeout=timeout,
    )
    duration_ms = round((time.monotonic() - started) * 1000, 3)
    stdout = redact(completed.stdout, secrets)
    stderr = redact(completed.stderr, secrets)
    request_record = {
        "transport": "subprocess",
        "command": argv,
        "exit_code": completed.returncode,
        "duration_ms": duration_ms,
        "credential_values_recorded": False,
    }
    if len(stdout) > max_bytes:
        raise ConnectorError(f"{provider} response exceeded max_response_bytes", request=request_record)
    if completed.returncode != 0:
        message = stderr.decode("utf-8", "replace").strip() or f"exit {completed.returncode}"
        raise ConnectorError(f"{provider} command failed: {message[:1000]}", raw=stdout, request=request_record)
    return stdout, stderr, request_record


def normalized_youtube_rows(operation: str, payload: Any) -> dict:
    if operation == "list_comments" and isinstance(payload, dict):
        rows = [
            {
                "id": row.get("commentId"),
                "author": row.get("author"),
                "author_url": row.get("authorChannelUrl"),
                "text": row.get("text"),
                "published_at": row.get("publishedAt"),
                "updated_at": row.get("updatedAt"),
                "metrics": {"likes": row.get("likeCount"), "replies": row.get("replyCount")},
                "source_url": f"https://www.youtube.com/watch?v={payload.get('videoId')}"
                if payload.get("videoId") else None,
            }
            for row in payload.get("comments", [])
            if isinstance(row, dict)
        ]
        return {"rows": rows, "count": len(rows), "page": {"fetched_pages": payload.get("fetchedPages")}}

    body = payload.get("results", payload) if isinstance(payload, dict) else payload
    items = body.get("items", []) if isinstance(body, dict) else (body if isinstance(body, list) else [])
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        snippet = item.get("snippet") if isinstance(item.get("snippet"), dict) else {}
        stats = item.get("statistics") if isinstance(item.get("statistics"), dict) else {}
        identifier = item.get("id")
        if isinstance(identifier, dict):
            identifier = identifier.get("videoId") or identifier.get("channelId") or identifier.get("playlistId")
        kind = item.get("kind") or (item.get("id", {}).get("kind") if isinstance(item.get("id"), dict) else None)
        source_url = None
        if identifier and ("video" in str(kind).casefold() or operation in {"search_videos", "get_video"}):
            source_url = f"https://www.youtube.com/watch?v={identifier}"
        elif identifier and operation == "get_channel":
            source_url = f"https://www.youtube.com/channel/{identifier}"
        rows.append(
            {
                "id": identifier,
                "kind": kind,
                "title": snippet.get("title"),
                "description": snippet.get("description"),
                "published_at": snippet.get("publishedAt"),
                "channel_id": snippet.get("channelId"),
                "channel_title": snippet.get("channelTitle"),
                "source_url": source_url,
                "metrics": {
                    "views": stats.get("viewCount"),
                    "likes": stats.get("likeCount"),
                    "comments": stats.get("commentCount"),
                    "subscribers": stats.get("subscriberCount"),
                    "videos": stats.get("videoCount"),
                },
            }
        )
    return {"rows": rows, "count": len(rows), "provider_meta": payload.get("meta", {}) if isinstance(payload, dict) else {}}


def youtube_pp(operation: str, params: dict, budget: dict, output_dir: Path | None = None) -> AdapterResult:
    binary = executable("CREATOR_YOUTUBE_PP_BIN", "youtube-pp-cli")
    common = ["--json", "--no-input", "--no-color", "--yes", "--data-source", "live"]
    if operation == "search_videos":
        query = require_text(params, "query")
        limit = optional_int(params, "limit", 25, 1, 50)
        order = params.get("order", "relevance")
        if order not in {"date", "rating", "viewCount", "relevance", "title"}:
            raise ValueError("params.order is not supported")
        argv = [binary, "youtube", "search-list", "--q", query, "--max-results", str(limit),
                "--type", "video", "--order", order, *common]
        for key, flag in (("published_after", "--published-after"), ("published_before", "--published-before"),
                          ("region_code", "--region-code"), ("language", "--relevance-language")):
            if params.get(key):
                argv += [flag, require_text(params, key)]
    elif operation == "get_channel":
        channel_id = params.get("channel_id")
        handle = params.get("handle")
        if bool(channel_id) == bool(handle):
            raise ValueError("provide exactly one of params.channel_id or params.handle")
        selector = ["--id", require_text(params, "channel_id")] if channel_id else ["--for-handle", require_text(params, "handle")]
        argv = [binary, "youtube", "channels-list", *selector, "--part", "snippet,statistics,contentDetails", *common]
    elif operation == "get_video":
        ids = params.get("video_ids", params.get("video_id"))
        if isinstance(ids, list):
            if not ids or not all(isinstance(item, str) and item.strip() for item in ids):
                raise ValueError("params.video_ids must be a non-empty list of strings")
            ids = ",".join(item.strip() for item in ids)
        if not isinstance(ids, str) or not ids.strip():
            raise ValueError("provide params.video_id or params.video_ids")
        argv = [binary, "youtube", "videos-list", "--id", ids.strip(),
                "--part", "snippet,statistics,contentDetails", *common]
    elif operation == "list_comments":
        video_id = require_text(params, "video_id")
        limit = optional_int(params, "limit", 20, 1, 100)
        order = params.get("order", "relevance")
        if order not in {"relevance", "time"}:
            raise ValueError("params.order must be relevance or time")
        argv = [binary, "youtube", "videos-comments", video_id, "--top", str(limit), "--order", order, *common]
    else:
        raise UnsupportedOperation(f"youtube-pp-connector does not implement operation: {operation}")
    payload, raw, request = run_json_command(
        argv, "YOUTUBE_API_KEY", budget["timeout_seconds"], budget["max_response_bytes"], "YouTube Data API"
    )
    return AdapterResult("YouTube Data API", normalized_youtube_rows(operation, payload), raw, request)


def http_json(url: str, headers: dict[str, str], timeout: int, max_bytes: int, provider: str) -> tuple[Any, bytes, dict]:
    secret_values = known_secret_values()
    request = urllib.request.Request(url, headers=headers, method="GET")
    started = time.monotonic()
    status_code = 0
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status_code = response.status
            raw = response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        status_code = error.code
        raw = error.read(max_bytes + 1)
    except Exception as error:
        record = {"transport": "https", "method": "GET", "target": url, "status_code": 0,
                  "duration_ms": round((time.monotonic() - started) * 1000, 3), "credential_values_recorded": False}
        raise ConnectorError(f"{provider} request failed: {type(error).__name__}: {error}", request=record) from error
    raw = redact(raw, secret_values)
    record = {"transport": "https", "method": "GET", "target": url, "status_code": status_code,
              "duration_ms": round((time.monotonic() - started) * 1000, 3), "credential_values_recorded": False}
    if len(raw) > max_bytes:
        raise ConnectorError(f"{provider} response exceeded max_response_bytes", request=record)
    if not 200 <= status_code < 300:
        raise ConnectorError(f"{provider} returned HTTP {status_code}", raw=raw, request=record)
    return parse_json_bytes(raw, provider), raw, record


def tubelab(operation: str, params: dict, budget: dict, output_dir: Path | None = None) -> AdapterResult:
    key = secret_value("TUBELAB_API_KEY")
    base = "https://public-api.tubelab.net/v1"
    limitations: list[str] = []
    if operation == "get_channel_videos":
        channel_id = require_text(params, "channel_id")
        if not channel_id.startswith("UC") or len(channel_id) != 24:
            raise ValueError("params.channel_id must be a 24-character YouTube UC channel ID")
        url = f"{base}/channel/videos/{urllib.parse.quote(channel_id, safe='')}"
    elif operation == "search_outliers":
        queries = params.get("queries")
        if not isinstance(queries, list) or not 1 <= len(queries) <= 4 or not all(isinstance(q, str) and q.strip() for q in queries):
            raise ValueError("params.queries must contain 1..4 non-empty strings")
        days = optional_int(params, "lookback_days", 30, 1, 365)
        size = optional_int(params, "limit", 20, 1, 50)
        min_views = optional_int(params, "min_views", 5000, 0, 2_147_483_647)
        published_after = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")
        pairs = [("type", "video"), ("language", params.get("language", "en")),
                 ("publishedAtFrom", published_after), ("viewCountFrom", str(min_views)),
                 ("size", str(size)), ("sortBy", "zScore"), ("sortOrder", "desc")]
        pairs.extend(("query", q.strip()) for q in queries)
        url = f"{base}/search/outliers?{urllib.parse.urlencode(pairs)}"
        if params.get("region_code"):
            limitations.append("TubeLab outlier endpoint does not provide a strict region filter; region is not enforced.")
    else:
        raise UnsupportedOperation(f"tubelab-connector does not implement operation: {operation}")
    payload, raw, request = http_json(
        url, {"Authorization": f"Api-Key {key}", "Accept": "application/json"},
        budget["timeout_seconds"], budget["max_response_bytes"], "TubeLab"
    )
    if operation == "get_channel_videos":
        item = payload.get("item") if isinstance(payload, dict) else None
        data = {"channel": item or {}, "count": len((item or {}).get("videos", [])) if isinstance(item, dict) else 0}
    else:
        hits = payload.get("hits", []) if isinstance(payload, dict) else []
        data = {"rows": hits, "count": len(hits)}
    return AdapterResult("TubeLab", data, raw, request, limitations=limitations)


SCRAPECREATORS_COMMANDS = {
    "resolve_profile": ("profile", (("handle", "--handle", True),)),
    "list_posts": ("user-posts", (("handle", "--handle", True), ("max_id", "--max-id", False))),
    "list_reels": ("user-reels", (("handle", "--handle", False), ("user_id", "--user-id", False),
                                  ("max_id", "--max-id", False))),
    "search_profiles": ("search-profiles", (("query", "--query", True),)),
    "list_comments": ("post-comments", (("url", "--url", True), ("cursor", "--cursor", False))),
    "get_transcript": ("media-transcript", (("url", "--url", True),)),
}


def scrapecreators(operation: str, params: dict, budget: dict, output_dir: Path | None = None) -> AdapterResult:
    binary = executable("CREATOR_SCRAPECREATORS_BIN", "scrapecreators")
    if operation == "discover_trending":
        if params.get("query"):
            command = "reels-search"
            specs = (("query", "--query", True), ("date_posted", "--date-posted", False), ("page", "--page", False))
        else:
            command, specs = "reels-trending", ()
    elif operation in SCRAPECREATORS_COMMANDS:
        command, specs = SCRAPECREATORS_COMMANDS[operation]
    else:
        raise UnsupportedOperation(f"scrapecreators-connector does not implement Instagram operation: {operation}")
    argv = [binary, "instagram", command]
    present_identity = False
    for name, flag, required in specs:
        value = params.get(name)
        if required:
            value = require_text(params, name)
        if value is not None and value != "":
            if name in {"handle", "user_id"}:
                present_identity = True
            argv += [flag, str(value).lstrip("@") if name == "handle" else str(value)]
    if operation == "list_reels" and not present_identity:
        raise ValueError("list_reels requires params.handle or params.user_id")
    payload, raw, request = run_json_command(
        argv, "SCRAPECREATORS_API_KEY", budget["timeout_seconds"], budget["max_response_bytes"], "ScrapeCreators"
    )
    if isinstance(payload, dict) and (payload.get("error") is True or payload.get("success") is False):
        raise ConnectorError(f"ScrapeCreators soft failure: {payload.get('message') or payload.get('code') or 'unknown'}",
                             raw=raw, request=request)
    credits = {
        "charged": payload.get("credits_charged"),
        "remaining": payload.get("credits_remaining"),
    } if isinstance(payload, dict) else {}
    data = {"payload": payload, "credits": credits}
    request["credits_charged"] = credits.get("charged")
    request["credits_remaining"] = credits.get("remaining")
    return AdapterResult("ScrapeCreators", data, raw, request)


def media_input(params: dict) -> str:
    value = require_text(params, "url")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme:
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError("params.url must use https")
        return value
    path = Path(value).expanduser().resolve()
    workspace_value = os.environ.get("CREATOR_V1_WORKSPACE", "").strip()
    workspace = Path(workspace_value).expanduser().resolve() if workspace_value else None
    if not path.is_file() or workspace is None or workspace not in path.parents:
        raise ValueError("local media must be an existing file under CREATOR_V1_WORKSPACE")
    return str(path)


def parse_vtt_cues(raw: bytes) -> tuple[str, list[dict]]:
    lines = []
    cues = []
    cue_time = None
    previous = None
    for raw_line in raw.decode("utf-8", "replace").splitlines():
        line = re.sub(r"<[^>]+>", "", raw_line).strip()
        if "-->" in line:
            cue_time = line.split("-->", 1)[0].strip()
            continue
        if not line or line == "WEBVTT" or line.startswith(("Kind:", "Language:")):
            continue
        if line.isdigit() or line == previous:
            continue
        lines.append(line)
        cues.append({"timestamp": cue_time, "text": line})
        previous = line
    return "\n".join(lines), cues


def normalize_media_metadata(payload: dict) -> dict:
    entries = payload.get("entries") if isinstance(payload.get("entries"), list) else [payload]
    rows = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        rows.append({
            "id": item.get("id"),
            "title": item.get("title"),
            "channel": item.get("channel") or item.get("uploader"),
            "channel_id": item.get("channel_id") or item.get("uploader_id"),
            "published_at": item.get("upload_date") or item.get("timestamp"),
            "duration_seconds": item.get("duration"),
            "source_url": item.get("webpage_url") or item.get("url"),
            "metrics": {
                "views": item.get("view_count"),
                "likes": item.get("like_count"),
                "comments": item.get("comment_count"),
            },
        })
    return {"rows": rows, "count": len(rows)}


def public_video_media(
    operation: str, params: dict, budget: dict, output_dir: Path | None = None
) -> AdapterResult:
    if output_dir is None:
        raise MissingPrerequisite("public-video-media requires an output directory")
    yt_dlp = executable("CREATOR_YTDLP_BIN", "yt-dlp")
    url = media_input(params)
    common = ["--no-warnings", "--no-call-home", "--no-progress"]
    if operation == "collect_public_metadata":
        limit = optional_int(params, "limit", 1, 1, 50)
        playlist = bool(params.get("playlist", False))
        argv = [yt_dlp, "--dump-single-json", "--skip-download", *common]
        if playlist:
            argv += ["--flat-playlist", "--playlist-end", str(limit)]
        else:
            argv += ["--no-playlist"]
        argv.append(url)
        stdout, _, request = run_bytes_command(
            argv, budget["timeout_seconds"], budget["max_response_bytes"], "Public video media"
        )
        payload = parse_json_bytes(stdout, "Public video media")
        return AdapterResult("Public video media", normalize_media_metadata(payload), stdout, request)

    artifacts_dir = output_dir / "media"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    if operation == "fetch_transcript":
        language = params.get("language", "en")
        if not isinstance(language, str) or not re.fullmatch(r"[A-Za-z0-9._*-]{1,32}", language):
            raise ValueError("params.language is invalid")
        with tempfile.TemporaryDirectory(prefix="creator-vtt-") as temp_dir:
            template = str(Path(temp_dir) / "transcript.%(ext)s")
            argv = [
                yt_dlp, "--skip-download", "--write-subs", "--write-auto-subs",
                "--sub-langs", language, "--sub-format", "vtt", "--no-playlist",
                "--output", template, *common, url,
            ]
            _, stderr, request = run_bytes_command(
                argv, budget["timeout_seconds"], budget["max_response_bytes"], "Public video media"
            )
            candidates = sorted(Path(temp_dir).glob("*.vtt"))
            if not candidates:
                return AdapterResult(
                    "Public video media",
                    {"language_requested": language, "transcript": "", "cues": [],
                     "caption_path": None, "caption_sha256": None, "caption_source": None},
                    stderr,
                    request,
                    status="completed_partial",
                    limitations=["No requested platform captions were available; no Whisper fallback was invoked."],
                    raw_suffix=".log",
                )
            source = candidates[0]
            target = artifacts_dir / source.name
            shutil.copy2(source, target)
            raw = target.read_bytes()
        transcript, cues = parse_vtt_cues(raw)
        data = {
            "language_requested": language,
            "transcript": transcript,
            "cues": cues,
            "caption_path": str(target),
            "caption_sha256": sha256_file(target),
            "caption_source": "platform_caption_or_auto_caption",
        }
        return AdapterResult("Public video media", data, raw, request, raw_suffix=".vtt")

    if operation == "extract_keyframes":
        frame_count = optional_int(params, "frame_count", 5, 1, 12)
        max_mb = optional_int(params, "max_download_mb", 50, 1, 200)
        with tempfile.TemporaryDirectory(prefix="creator-media-") as temp_dir:
            template = str(Path(temp_dir) / "source.%(ext)s")
            argv = [
                yt_dlp, "--no-playlist", "--max-filesize", f"{max_mb}M",
                "--format", "worst[ext=mp4]/worst", "--output", template, *common, url,
            ]
            _, stderr, request = run_bytes_command(
                argv, budget["timeout_seconds"], budget["max_response_bytes"], "Public video media"
            )
            media_files = [path for path in Path(temp_dir).iterdir() if path.is_file()]
            if not media_files:
                raise ConnectorError("Public video media produced no bounded media file", raw=stderr, request=request)
            media = max(media_files, key=lambda path: path.stat().st_size)
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(media)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=30,
            )
            if probe.returncode != 0:
                raise ConnectorError("ffprobe could not read downloaded media", raw=probe.stderr, request=request)
            duration = float(json.loads(probe.stdout.decode("utf-8"))["format"]["duration"])
            if duration <= 0:
                raise ConnectorError("media duration is not positive", request=request)
            timestamps = [round(duration * (index + 1) / (frame_count + 1), 3) for index in range(frame_count)]
            frames = []
            for index, timestamp in enumerate(timestamps, 1):
                target = artifacts_dir / f"frame-{index:02d}-{timestamp:.3f}s.jpg"
                completed = subprocess.run(
                    ["ffmpeg", "-v", "error", "-ss", str(timestamp), "-i", str(media),
                     "-frames:v", "1", "-q:v", "3", "-y", str(target)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=60,
                )
                if completed.returncode != 0 or not target.is_file():
                    raise ConnectorError(f"ffmpeg failed at {timestamp}s", raw=completed.stderr, request=request)
                frames.append({"timestamp_seconds": timestamp, "path": str(target), "sha256": sha256_file(target)})
            raw = json.dumps({"duration_seconds": duration, "frames": frames}, ensure_ascii=False).encode("utf-8")
        return AdapterResult(
            "Public video media",
            {"duration_seconds": duration, "frame_count": len(frames), "frames": frames,
             "selection": "evenly_spaced_bounded_v1"},
            raw,
            request,
        )
    raise UnsupportedOperation(f"public-video-media does not implement operation: {operation}")


def gemini_video(
    operation: str, params: dict, budget: dict, output_dir: Path | None = None
) -> AdapterResult:
    if operation != "analyze_video":
        raise UnsupportedOperation(f"gemini-video-adapter does not implement operation: {operation}")
    if output_dir is None:
        raise MissingPrerequisite("gemini-video-adapter requires an output directory")
    videos = params.get("videos")
    if not isinstance(videos, list) or not 1 <= len(videos) <= 3 or not all(isinstance(row, dict) for row in videos):
        raise ValueError("params.videos must contain 1..3 video objects")
    platform = params.get("platform", "youtube")
    if platform not in {"youtube", "instagram", "tiktok"}:
        raise ValueError("params.platform must be youtube, instagram or tiktok")
    analyzer_root = Path(os.environ.get("CREATOR_HEAD_VIDEO_ANALYZER_ROOT", "")).expanduser().resolve()
    analyzer = analyzer_root / "scripts" / "analyze_videos.py"
    if not analyzer.is_file():
        raise MissingPrerequisite("missing built head-video-analyzer; configure CREATOR_HEAD_VIDEO_ANALYZER_ROOT")
    pythonpath = Path(os.environ.get("CREATOR_GEMINI_PYTHONPATH", "")).expanduser().resolve()
    if not pythonpath.is_dir():
        raise MissingPrerequisite("missing locked Gemini Python dependencies; configure CREATOR_GEMINI_PYTHONPATH")
    python = executable("CREATOR_GEMINI_PYTHON", "python3")
    input_path = output_dir / "gemini-input.json"
    analysis_path = output_dir / "gemini-analysis.json"
    atomic_json(input_path, {"outliers": videos})
    argv = [
        python, str(analyzer), "--input", str(input_path), "--output", str(analysis_path),
        "--platform", platform, "--max-videos", str(len(videos)),
    ]
    _, stderr, request = run_bytes_command(
        argv, budget["timeout_seconds"], budget["max_response_bytes"], "Google Gemini",
        required_secret="GEMINI_API_KEY",
        extra_env={"PYTHONPATH": str(pythonpath), "GEMINI_MODEL": os.environ.get("GEMINI_MODEL", "gemini-flash-latest")},
    )
    if not analysis_path.is_file():
        raise ConnectorError("Gemini analyzer produced no result file", raw=stderr, request=request)
    raw = analysis_path.read_bytes()
    payload = parse_json_bytes(raw, "Google Gemini")
    if not isinstance(payload, list) or not payload:
        raise ConnectorError("Gemini analyzer returned no analyzed rows", raw=raw, request=request)
    failures = [row for row in payload if isinstance(row, dict) and (row.get("error") or not row.get("analysis"))]
    status = "completed_partial" if failures else "completed"
    limitations = [f"{len(failures)}/{len(payload)} videos lacked a valid analysis"] if failures else []
    return AdapterResult(
        "Google Gemini", {"rows": payload, "count": len(payload), "failed_count": len(failures)},
        raw, request, status=status, limitations=limitations,
    )


ADAPTERS = {
    "youtube-pp-connector": youtube_pp,
    "tubelab-connector": tubelab,
    "scrapecreators-connector": scrapecreators,
    "public-video-media": public_video_media,
    "gemini-video-adapter": gemini_video,
}


def execute(request: dict, output_dir: Path) -> tuple[dict, int]:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))["connectors"]
    connector_id = request["connector_id"]
    operation = request["operation"]
    retrieved_at = utc_now()
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    raw_dir.mkdir(exist_ok=True)
    started = time.monotonic()
    raw = b""
    provider = registry.get(connector_id, {}).get("provider", connector_id)
    provider_request: dict = {}
    limitations: list[str] = []
    data: Any = None
    try:
        if connector_id not in registry:
            raise UnsupportedOperation(f"unknown Connector: {connector_id}")
        if operation not in registry[connector_id].get("operations", []):
            raise UnsupportedOperation(f"{connector_id} does not declare operation: {operation}")
        adapter = ADAPTERS.get(connector_id)
        if adapter is None:
            raise MissingPrerequisite(registry[connector_id].get("block_reason") or "Connector adapter is not implemented")
        adapter_result = adapter(operation, request["params"], request["budget"], output_dir)
        provider = adapter_result.provider
        raw = adapter_result.raw
        provider_request = adapter_result.provider_request
        data = adapter_result.data
        limitations = adapter_result.limitations
        status = adapter_result.status
        summary = f"{connector_id}.{operation} completed"
    except ConnectorError as error:
        status = error.status
        summary = str(error)
        raw = error.raw
        provider_request = error.request
        limitations = [str(error)]
    except (ValueError, json.JSONDecodeError) as error:
        status = "failed"
        summary = f"invalid Connector request: {error}"
        limitations = [str(error)]
    raw_suffix = adapter_result.raw_suffix if "adapter_result" in locals() else ".json"
    raw_path = raw_dir / f"{connector_id}-{operation}{raw_suffix}"
    raw_path.write_bytes(raw)
    raw_hash = sha256_bytes(raw)
    result = {
        "schema_version": "1.0",
        "request_id": request["request_id"],
        "connector_id": connector_id,
        "operation": operation,
        "provider": provider,
        "status": status,
        "summary": summary,
        "data": data,
        "evidence": [{
            "source": f"connector://{connector_id}/{operation}",
            "retrieved_at": retrieved_at,
            "provider": provider,
            "raw_path": str(raw_path),
            "raw_hash": raw_hash,
        }],
        "provider_requests": [provider_request] if provider_request else [],
        "limitations": limitations,
        "credential_values_recorded": False,
        "duration_ms": round((time.monotonic() - started) * 1000, 3),
    }
    atomic_json(output_dir / "result.json", result)
    atomic_json(output_dir / "run_manifest.json", {
        "schema_version": "1.0",
        "request_id": request["request_id"],
        "connector_id": connector_id,
        "operation": operation,
        "status": status,
        "retrieved_at": retrieved_at,
        "provider_requests": result["provider_requests"],
        "artifacts": [
            {"kind": "raw_provider_response", "path": str(raw_path), "sha256": raw_hash},
            {"kind": "normalized_result", "path": str(output_dir / "result.json"), "sha256": None},
        ],
        "secret_names": registry.get(connector_id, {}).get("required_secrets", []),
        "secret_values_recorded": False,
    })
    return result, STATUS_EXIT[status]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        request_path = args.request.expanduser().resolve(strict=True)
        output_dir = args.output_dir.expanduser().resolve()
        if output_dir == PLUGIN_ROOT or PLUGIN_ROOT in output_dir.parents:
            raise ValueError("output-dir must be outside the installed Plugin tree")
        request = parse_request(request_path)
        result, exit_code = execute(request, output_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return exit_code
    except Exception as error:
        print(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

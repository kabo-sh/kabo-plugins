#!/usr/bin/env python3
"""Append and compare immutable creator metric snapshots outside Git."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


SAFE_ID = re.compile(r"[A-Za-z0-9._-]{1,96}")


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def root_path() -> Path:
    raw = os.environ.get("CREATOR_SKILLS_SNAPSHOT_ROOT", "").strip()
    if not raw:
        raise RuntimeError("CREATOR_SKILLS_SNAPSHOT_ROOT is not configured")
    root = Path(raw).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    return root


def safe_id(value: str, label: str) -> str:
    if not SAFE_ID.fullmatch(value):
        raise ValueError(f"{label} must match {SAFE_ID.pattern}")
    return value


def timestamp(value: str) -> tuple[str, str]:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("observed_at must include a timezone")
    utc = parsed.astimezone(timezone.utc)
    return utc.isoformat(), utc.strftime("%Y%m%dT%H%M%S%fZ")


def normalized_rows(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not rows:
        raise ValueError("input must contain a non-empty rows list")
    normalized = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("every row must be an object")
        creator_id = str(row.get("creator_id", "")).strip()
        safe_id(creator_id, "creator_id")
        if creator_id in seen:
            raise ValueError(f"duplicate creator_id: {creator_id}")
        seen.add(creator_id)
        metrics = row.get("metrics")
        if not isinstance(metrics, dict) or not metrics:
            raise ValueError(f"metrics must be a non-empty object for {creator_id}")
        clean_metrics = {}
        for name, value in metrics.items():
            safe_id(str(name), "metric name")
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"metric {name} for {creator_id} must be numeric")
            clean_metrics[str(name)] = value
        normalized.append({
            "creator_id": creator_id,
            "source_url": row.get("source_url"),
            "metrics": clean_metrics,
        })
    return sorted(normalized, key=lambda row: row["creator_id"])


def append_snapshot(args: argparse.Namespace) -> int:
    universe = safe_id(args.universe, "universe")
    request_id = safe_id(args.request_id, "request_id")
    observed_at, filename_time = timestamp(args.observed_at)
    rows = normalized_rows(args.input.resolve())
    directory = root_path() / universe
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    target = directory / f"{filename_time}-{request_id}.json"
    payload = {
        "schema_version": 1,
        "universe": universe,
        "request_id": request_id,
        "observed_at": observed_at,
        "rows": rows,
    }
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    print(json.dumps({
        "status": "appended",
        "path": str(target),
        "sha256": digest(target),
        "observed_at": observed_at,
        "row_count": len(rows),
    }, ensure_ascii=False))
    return 0


def load_snapshot(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {**payload, "path": str(path), "sha256": digest(path)}


def compare(args: argparse.Namespace) -> int:
    universe = safe_id(args.universe, "universe")
    directory = root_path() / universe
    paths = sorted(directory.glob("*.json")) if directory.is_dir() else []
    if len(paths) < 2:
        latest = load_snapshot(paths[-1]) if paths else None
        print(json.dumps({
            "status": "insufficient_snapshots",
            "universe": universe,
            "snapshot_count": len(paths),
            "latest": latest,
            "claim_boundary": "recent_strong_performance_only",
        }, ensure_ascii=False))
        return 0
    def selected_path(value: str | None, default: Path) -> Path:
        selected = Path(value).expanduser().resolve() if value else default.resolve()
        if directory.resolve() not in selected.parents or selected.suffix != ".json" or not selected.is_file():
            raise ValueError("selected snapshot must be an existing JSON file in the requested universe")
        return selected

    older = load_snapshot(selected_path(args.older, paths[-2]))
    newer = load_snapshot(selected_path(args.newer, paths[-1]))
    old_rows = {row["creator_id"]: row for row in older["rows"]}
    new_rows = {row["creator_id"]: row for row in newer["rows"]}
    rows = []
    for creator_id in sorted(old_rows.keys() & new_rows.keys()):
        old_metrics = old_rows[creator_id]["metrics"]
        new_metrics = new_rows[creator_id]["metrics"]
        deltas = {}
        for name in sorted(old_metrics.keys() & new_metrics.keys()):
            old_value, new_value = old_metrics[name], new_metrics[name]
            delta = new_value - old_value
            deltas[name] = {
                "older": old_value,
                "newer": new_value,
                "delta": delta,
                "growth_ratio": (delta / old_value) if old_value else None,
            }
        rows.append({"creator_id": creator_id, "metrics": deltas})
    print(json.dumps({
        "status": "comparable",
        "universe": universe,
        "older": {key: older[key] for key in ("path", "sha256", "observed_at")},
        "newer": {key: newer[key] for key in ("path", "sha256", "observed_at")},
        "coverage": {"older": len(old_rows), "newer": len(new_rows), "comparable": len(rows)},
        "rows": rows,
    }, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    append = commands.add_parser("append")
    append.add_argument("--universe", required=True)
    append.add_argument("--request-id", required=True)
    append.add_argument("--observed-at", required=True)
    append.add_argument("--input", type=Path, required=True)
    append.set_defaults(handler=append_snapshot)
    comparison = commands.add_parser("compare")
    comparison.add_argument("--universe", required=True)
    comparison.add_argument("--older")
    comparison.add_argument("--newer")
    comparison.set_defaults(handler=compare)
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise SystemExit(2)

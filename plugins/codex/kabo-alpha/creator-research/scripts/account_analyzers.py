#!/usr/bin/env python3
"""Shared deterministic account analyzers for public and owner snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


RULE_VERSION = "account-analysis.v3.3"
AVAILABLE = {"available", "zero"}
NON_COMPARABLE_FORMATS = {"unknown", "unknown_video", "format_unknown", "unclassified"}
FORMAT_CONFIDENCE_PRIORITY = {"unknown": 0, "provisional": 1, "explicit": 2}
METRIC_PRIORITY = (
    "views", "reach", "watch_hours", "average_view_duration_seconds",
    "average_percentage_viewed", "average_watch_time_seconds",
    "three_second_skip_rate_percent", "impressions", "impressions_ctr",
    "total_interactions", "likes", "comments", "shares", "saves",
    "subscribers_gained", "subscribers_lost", "profile_links_taps",
)


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_time(raw: str) -> datetime:
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def number(value: Any) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return value


def metric_map(source: dict[str, Any]) -> dict[str, float | int]:
    result: dict[str, float | int] = {}
    for name, item in source.items():
        if isinstance(item, dict):
            value = number(item.get("value")) if item.get("status") in AVAILABLE else None
        else:
            value = number(item)
        if value is not None:
            normalized = "average_watch_time_seconds" if name == "average_watch_time_ms" else name
            result[normalized] = round(value / 1000, 6) if name == "average_watch_time_ms" else value
    return result


def normalize_format(value: str | None, media_type: str | None = None) -> str:
    raw = (value or media_type or "unknown").strip().lower()
    return {
        "reels": "reel", "instagram_reel": "reel",
        "instagram_feed": "feed", "shorts": "short", "videos": "video",
        "image": "feed", "carousel_album": "feed",
    }.get(raw, raw)


def comparable_format(value: Any) -> bool:
    return str(value or "").strip().casefold() not in NON_COMPARABLE_FORMATS


def first_line(text: str | None, fallback: str) -> str:
    value = (text or "").strip().splitlines()[0] if (text or "").strip() else fallback
    return value[:180]


def canonical_handle(value: str | None) -> str:
    return (value or "").strip().removeprefix("@").casefold()


def select_focus_creator_id(
    creators: dict[str, dict[str, Any]],
    focus_creator_id: str | None,
    focus_handle: str | None,
) -> str:
    if focus_creator_id is not None:
        if focus_creator_id not in creators:
            raise ValueError(f"unknown focus creator: {focus_creator_id}")
        if focus_handle and canonical_handle(creators[focus_creator_id].get("handle")) != canonical_handle(focus_handle):
            raise ValueError("focus creator id and handle refer to different accounts")
        return focus_creator_id
    if focus_handle:
        target = canonical_handle(focus_handle)
        matches = [
            creator_id for creator_id, creator in creators.items()
            if canonical_handle(creator.get("handle")) == target
        ]
        if len(matches) != 1:
            reason = "unknown" if not matches else "ambiguous"
            raise ValueError(f"{reason} focus handle: {focus_handle}")
        return matches[0]
    if len(creators) != 1:
        raise ValueError("public snapshot with multiple creators requires --focus-handle or --focus-creator-id")
    return next(iter(creators))


def resolve_duplicate_format_evidence(
    rows: list[dict[str, Any]], content_id: str
) -> dict[str, str]:
    """Resolve duplicate format claims without making discovery order authoritative."""
    evidence = []
    for row in rows:
        confidence = row.get("format_confidence")
        confidence = confidence.strip() if isinstance(confidence, str) and confidence.strip() else None
        source = row.get("format_source")
        source = source.strip() if isinstance(source, str) and source.strip() else None
        evidence.append({
            "format": str(row.get("format") or "unknown"),
            "confidence": confidence,
            "source": source,
            "priority": FORMAT_CONFIDENCE_PRIORITY.get(confidence, 0 if confidence else -1),
        })

    strongest_priority = max(item["priority"] for item in evidence)
    strongest = [item for item in evidence if item["priority"] == strongest_priority]
    formats = sorted({item["format"] for item in strongest})
    if len(formats) > 1:
        if strongest_priority == FORMAT_CONFIDENCE_PRIORITY["explicit"]:
            raise ValueError(
                f"{content_id}: conflicting explicit format evidence: {' versus '.join(formats)}"
            )
        if strongest_priority >= FORMAT_CONFIDENCE_PRIORITY["unknown"]:
            label = "provisional" if strongest_priority == FORMAT_CONFIDENCE_PRIORITY["provisional"] else "unknown"
            return {
                "format": "unknown",
                "format_confidence": "unknown",
                "format_source": f"conflicting_{label}",
            }
        return {"format": "unknown"}

    resolved = {"format": formats[0]}
    confidences = sorted({item["confidence"] for item in strongest if item["confidence"]})
    sources = sorted({item["source"] for item in strongest if item["source"]})
    if confidences:
        # Recognized confidence values have distinct priorities. Sorting only canonicalizes an
        # unsupported legacy tie, keeping duplicate input order out of the result.
        resolved["format_confidence"] = confidences[-1]
    if sources:
        resolved["format_source"] = sources[0]
    return resolved


def deduplicate_records(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Merge repeated content rows without converting missing metrics into zeros."""
    unique: dict[str, dict[str, Any]] = {}
    evidence_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    duplicates = 0
    for row in records:
        content_id = str(row["content_id"])
        evidence_rows[content_id].append(row)
        existing = unique.get(content_id)
        if existing is None:
            unique[content_id] = row
            continue
        duplicates += 1
        existing["url"] = existing.get("url") or row.get("url")
        existing["text"] = existing.get("text") or row.get("text") or ""
        existing["title"] = existing.get("title") or row.get("title") or content_id
        for name, value in row.get("metrics", {}).items():
            existing.setdefault("metrics", {}).setdefault(name, value)
    for content_id, existing in unique.items():
        resolved = resolve_duplicate_format_evidence(evidence_rows[content_id], content_id)
        existing["format"] = resolved["format"]
        for field in ("format_confidence", "format_source"):
            existing.pop(field, None)
            if field in resolved:
                existing[field] = resolved[field]
    return list(unique.values()), duplicates


def format_classification(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]] | None:
    """Summarize declared versus inferred format evidence without inventing provenance."""
    if not any("format_confidence" in row or "format_source" in row for row in rows):
        return None
    confidence_counts: dict[str, int] = defaultdict(int)
    source_counts: dict[str, int] = defaultdict(int)
    for row in rows:
        confidence = row.get("format_confidence")
        source = row.get("format_source")
        confidence_key = confidence if isinstance(confidence, str) and confidence.strip() else "unreported"
        source_key = source if isinstance(source, str) and source.strip() else "unreported"
        confidence_counts[confidence_key] += 1
        source_counts[source_key] += 1
    return {
        "confidence_counts": dict(sorted(confidence_counts.items())),
        "source_counts": dict(sorted(source_counts.items())),
    }


def adapt_snapshot(
    snapshot: dict[str, Any],
    focus_creator_id: str | None = None,
    focus_handle: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    version = snapshot.get("schema_version")
    records: list[dict[str, Any]] = []
    if version == "normalized-social-snapshot.v1":
        until = snapshot.get("scope", {}).get("until")
        observed = snapshot.get("source", {}).get("generated_at") or f"{until}T23:59:59+00:00"
        scope = {
            "account": snapshot.get("scope", {}).get("account_ref", "unknown"),
            "window": {"start": snapshot.get("scope", {}).get("since"), "end": until},
            "observed_at": parse_time(observed).isoformat(),
        }
        for post in snapshot.get("posts", []):
            metrics = metric_map(post.get("owner_metrics", {}))
            for name, value in post.get("public_metrics", {}).items():
                if name not in metrics and number(value) is not None:
                    metrics[name] = value
            records.append({
                "content_id": str(post["post_id"]),
                "title": first_line(post.get("caption"), str(post["post_id"])),
                "text": post.get("caption") or "",
                "url": post.get("permalink"),
                "published_at": parse_time(post["timestamp"]).isoformat(),
                "format": normalize_format(post.get("media_product_type"), post.get("media_type")),
                "metrics": metrics,
            })
        meta = {
            "snapshot_id": snapshot["snapshot_id"], "platform": snapshot.get("platform", "unknown"),
            "source_mode": snapshot.get("source_mode", "owner_export"), "scope": scope,
            "source_coverage": snapshot.get("coverage", {}), "account_metrics": metric_map(snapshot.get("account_metrics", {})),
        }
    elif version == "public-content-snapshot.v1":
        creators = {row["creator_id"]: row for row in snapshot.get("creators", [])}
        focus_creator_id = select_focus_creator_id(creators, focus_creator_id, focus_handle)
        for item in snapshot.get("items", []):
            if item.get("creator_id") != focus_creator_id:
                continue
            content_id = str(item["content_id"])
            record = {
                "content_id": content_id, "title": item.get("title") or content_id,
                "text": item.get("title") or "", "url": item.get("url"),
                "published_at": parse_time(item["published_at"]).isoformat(),
                "format": normalize_format(item.get("format")), "metrics": metric_map(item.get("metrics", {})),
            }
            for field in ("format_confidence", "format_source"):
                value = item.get(field)
                if isinstance(value, str) and value.strip():
                    record[field] = value
            records.append(record)
        window = snapshot.get("scope", {}).get("window", {})
        source = snapshot.get("source", {})
        source_coverage = {
            "catalog_items": len(records),
            "coverage_complete": bool(source.get("coverage_complete")),
        }
        if isinstance(source.get("pagination"), dict):
            source_coverage["pagination"] = source["pagination"]
        if isinstance(source.get("limitations"), list):
            source_coverage["limitations"] = source["limitations"]
        meta = {
            "snapshot_id": snapshot["snapshot_id"], "platform": snapshot.get("platform", "unknown"),
            "source_mode": source.get("source_mode", "public"),
            "scope": {"account": creators[focus_creator_id].get("handle", focus_creator_id), "window": window, "observed_at": parse_time(snapshot["observed_at"]).isoformat()},
            "source_coverage": source_coverage,
            "account_metrics": {},
        }
    elif version == "youtube-owner-analysis-snapshot.v1":
        source = snapshot.get("source", {})
        window = source.get("window", {})
        observed = source.get("generated_at") or f"{window.get('end')}T23:59:59+00:00"
        for item in snapshot.get("content", []):
            records.append({
                "content_id": str(item["content_id"]), "title": item.get("title") or str(item["content_id"]),
                "text": item.get("title") or "", "url": item.get("url"),
                "published_at": parse_time(item["published_at"]).isoformat(),
                "format": normalize_format(item.get("format")), "metrics": metric_map(item.get("metrics", {})),
            })
        account = snapshot.get("account", {})
        meta = {
            "snapshot_id": snapshot["snapshot_id"], "platform": "youtube", "source_mode": source.get("mode", "owner_oauth"),
            "scope": {"account": account.get("handle") or account.get("channel_id") or "unknown", "window": {"start": window.get("start"), "end": window.get("end")}, "observed_at": parse_time(observed).isoformat()},
            "source_coverage": snapshot.get("coverage", {}), "account_metrics": {key: value for key, value in snapshot.get("totals", {}).items() if number(value) is not None},
        }
    else:
        raise ValueError(f"unsupported snapshot schema: {version}")
    input_rows = len(records)
    records, duplicate_rows_merged = deduplicate_records(records)
    meta["normalization"] = {
        "input_rows": input_rows,
        "normalized_records": len(records),
        "duplicate_rows_merged": duplicate_rows_merged,
    }
    if not records:
        raise ValueError("snapshot contains no content for the requested account")
    return meta, records


def median(values: list[float | int]) -> float | int | None:
    return round(statistics.median(values), 6) if values else None


def mean(values: list[float | int]) -> float | int | None:
    return round(statistics.mean(values), 6) if values else None


def comparable_records(records: list[dict[str, Any]], end: datetime, maturity_days: int) -> dict[str, list[dict[str, Any]]]:
    cutoff = end - timedelta(days=max(maturity_days - 1, 0))
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in records:
        if comparable_format(row["format"]) and parse_time(row["published_at"]) <= cutoff:
            grouped[row["format"]].append(row)
    return dict(grouped)


def calculate_baselines(records: list[dict[str, Any]], end: datetime, maturity_days: int) -> list[dict[str, Any]]:
    result = []
    for content_format, rows in sorted(comparable_records(records, end, maturity_days).items()):
        metrics = {}
        names = [name for name in METRIC_PRIORITY if any(name in row["metrics"] for row in rows)]
        for name in names:
            values = [row["metrics"][name] for row in rows if name in row["metrics"]]
            metrics[name] = {"available_n": len(values), "median": median(values), "mean": mean(values)}
        baseline = {"format": content_format, "maturity_days": maturity_days, "sample_size": len(rows), "metrics": metrics}
        classification = format_classification(rows)
        if classification is not None:
            baseline["format_classification"] = classification
        result.append(baseline)
    return result


def rank_content(records: list[dict[str, Any]], baselines: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    baseline_map = {row["format"]: row for row in baselines}
    rankings, outliers = [], []
    for row in records:
        views = row["metrics"].get("views")
        baseline = baseline_map.get(row["format"], {})
        view_stats = baseline.get("metrics", {}).get("views", {})
        baseline_views = view_stats.get("median")
        sample_size = baseline.get("sample_size", 0)
        multiple = round(views / baseline_views, 6) if views is not None and baseline_views not in {None, 0} and sample_size >= 3 else None
        item = {key: row[key] for key in ("content_id", "title", "url", "published_at", "format")}
        for field in ("format_confidence", "format_source"):
            if field in row:
                item[field] = row[field]
        item["metrics"] = {name: row["metrics"][name] for name in METRIC_PRIORITY if name in row["metrics"]}
        item["view_multiple_vs_format_median"] = multiple
        rankings.append(item)
        outlier = {"content_id": row["content_id"], "format": row["format"], "views": views, "baseline_median_views": baseline_views, "comparable_n": sample_size, "view_multiple": multiple}
        for field in ("format_confidence", "format_source"):
            if field in row:
                outlier[field] = row[field]
        outliers.append(outlier)
    rankings.sort(key=lambda row: (-(row["metrics"].get("views") or -1), row["content_id"]))
    for index, row in enumerate(rankings, 1):
        row["rank_by_views"] = index
    outliers.sort(key=lambda row: (row["view_multiple"] is None, -(row["view_multiple"] or -1), row["content_id"]))
    return rankings, outliers


def inspect_coverage(meta: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, Any]:
    metric_counts: dict[str, int] = defaultdict(int)
    for row in records:
        for name in row["metrics"]:
            metric_counts[name] += 1
    missing = []
    if meta["source_mode"].startswith("public") or meta["source_mode"] == "public":
        missing += ["private_retention", "private_ctr", "audience_demographics", "conversion"]
    result = {
        "content_total": len(records), "formats": dict(sorted((name, sum(row["format"] == name for row in records)) for name in {row["format"] for row in records})),
        "metric_available_counts": dict(sorted(metric_counts.items())), "source_coverage": meta["source_coverage"], "missing": missing,
        "normalization": meta["normalization"],
    }
    classification = format_classification(records)
    if classification is not None:
        result["format_classification"] = classification
    return result


def analyze_funnel(meta: dict[str, Any], records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    signals: list[dict[str, Any]] = []
    account = meta.get("account_metrics", {})
    for name in ("views", "reach", "total_interactions", "profile_links_taps", "subscribers_gained"):
        if name in account:
            signals.append({"stage": "account_window", "metric": name, "value": account[name]})
    for name in ("saves", "shares"):
        values = [row["metrics"][name] for row in records if name in row["metrics"]]
        if values:
            signals.append({"stage": "content_action", "metric": f"zero_{name}_content", "value": sum(value == 0 for value in values), "sample_size": len(values)})
    return signals


def analyze_pillars(records: list[dict[str, Any]], baselines: list[dict[str, Any]], classification: dict[str, Any] | None) -> list[dict[str, Any]]:
    if classification is None:
        return []
    labels = {str(item["content_id"]): item["pillar"] for item in classification.get("items", [])}
    unknown = sorted(set(labels) - {row["content_id"] for row in records})
    if unknown:
        raise ValueError(f"classification references unknown content IDs: {unknown}")
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in records:
        if row["content_id"] in labels:
            grouped[labels[row["content_id"]]].append(row)
    baseline_map = {row["format"]: row for row in baselines}
    result = []
    for pillar, rows in sorted(grouped.items()):
        views = [row["metrics"]["views"] for row in rows if "views" in row["metrics"]]
        multiples = []
        for row in rows:
            base = baseline_map.get(row["format"], {}).get("metrics", {}).get("views", {}).get("median")
            if "views" in row["metrics"] and base not in {None, 0}:
                multiples.append(row["metrics"]["views"] / base)
        top = sorted(rows, key=lambda row: -(row["metrics"].get("views") or -1))[:3]
        result.append({
            "pillar": pillar, "sample_size": len(rows),
            "format_breakdown": dict(sorted((name, sum(row["format"] == name for row in rows)) for name in {row["format"] for row in rows})),
            "median_views": median(views), "median_relative_to_format_baseline": median(multiples),
            "top_examples": [{"content_id": row["content_id"], "title": row["title"], "url": row["url"], "views": row["metrics"].get("views")} for row in top],
        })
    return result


def claim_boundary(meta: dict[str, Any]) -> dict[str, Any]:
    public = meta["source_mode"].startswith("public") or meta["source_mode"] == "public"
    allowed = ["current_performance", "personal_baseline", "account_relative_outlier", "content_ranking"]
    if not public:
        allowed += ["available_owner_metrics", "owner_funnel_signals"]
    return {
        "allowed": allowed,
        "not_allowed": ["causal_attribution", "growth_without_comparable_snapshots"] + (["private_retention", "private_ctr", "audience_demographics", "conversion"] if public else []),
    }


def analyze(
    snapshot: dict[str, Any],
    focus_creator_id: str | None = None,
    maturity_days: int = 14,
    classification: dict[str, Any] | None = None,
    focus_handle: str | None = None,
) -> dict[str, Any]:
    meta, records = adapt_snapshot(snapshot, focus_creator_id, focus_handle)
    window_end = meta["scope"].get("window", {}).get("end")
    end = parse_time(f"{window_end}T23:59:59+00:00") if window_end and "T" not in window_end else parse_time(window_end or meta["scope"]["observed_at"])
    baselines = calculate_baselines(records, end, maturity_days)
    rankings, outliers = rank_content(records, baselines)
    analysis_id = "account-analysis-" + hashlib.sha256(f"{meta['snapshot_id']}:{RULE_VERSION}:{maturity_days}:{canonical_hash(classification or {})}".encode()).hexdigest()[:16]
    return {
        "schema_version": "account-analysis.v3", "analysis_id": analysis_id,
        "snapshot_id": meta["snapshot_id"], "platform": meta["platform"], "source_mode": meta["source_mode"],
        "rule_version": RULE_VERSION, "scope": meta["scope"], "coverage": inspect_coverage(meta, records),
        "baselines": baselines, "rankings": rankings, "outliers": outliers,
        "pillar_performance": analyze_pillars(records, baselines, classification),
        "funnel_signals": analyze_funnel(meta, records), "claim_boundary": claim_boundary(meta),
    }


def select_operation(analysis: dict[str, Any], operation: str) -> Any:
    return {
        "all": analysis, "coverage": analysis["coverage"], "baselines": analysis["baselines"],
        "rank": {"rankings": analysis["rankings"], "outliers": analysis["outliers"]},
        "pillars": analysis["pillar_performance"], "funnel": analysis["funnel_signals"],
    }[operation]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--operation", choices=("all", "coverage", "baselines", "rank", "pillars", "funnel"), default="all")
    parser.add_argument("--focus-creator-id")
    parser.add_argument("--focus-handle")
    parser.add_argument("--maturity-days", type=int, default=14)
    parser.add_argument("--classification", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.maturity_days < 1:
            raise ValueError("maturity-days must be positive")
        classification = load(args.classification) if args.classification else None
        if args.operation == "pillars" and classification is None:
            raise ValueError("pillars operation requires --classification")
        result = select_operation(analyze(
            load(args.snapshot),
            focus_creator_id=args.focus_creator_id,
            maturity_days=args.maturity_days,
            classification=classification,
            focus_handle=args.focus_handle,
        ), args.operation)
        dump(args.output, result)
        return 0
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

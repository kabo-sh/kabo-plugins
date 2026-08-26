#!/usr/bin/env python3
"""Assemble one public-content-snapshot.v1 from the connector envelopes of a single run.

Why this file exists, and where its line is:
  The data plane answers one call with one envelope (the provider payload, passed through
  verbatim), while every V2 analyzer reads a single assembled `public-content-snapshot.v1`.
  Turning N envelopes into 1 snapshot is the step nobody shipped. It lives beside
  snapshot_store.py rather than inside a skill package or on the server: stdlib only,
  offline, no environment lookup, no variant-specific branch, and versioned with the plugin
  so min_plugin_version gates it across the fleet.

  It reshapes; it never judges. No ranking, no multiples, no outlier verdicts - those belong
  to the frozen analyzers, and computing them here would quietly replace them.

`items[].format` is narrowed to youtube_short / youtube_long / unknown / instagram_reel /
instagram_feed even though the
snapshot schema declares plain {"type": "string"} for it. The narrowing is deliberate and is
Kabo's, not upstream's: it is exactly the content-format enum the Kabo server uses for creator
observations, so the day these items are normalized into observations there is nothing left to
translate. Ranking never mixes formats, so a wrong label is a wrong cohort, not a cosmetic
defect. YouTube duration remains evidence but is not a format signal: a horizontal video can be
three minutes or less, and treating it as a Short would contaminate every same-format baseline.

`observed_at`, `source.retrieved_at` and `source.raw_sha256` come from the envelope, i.e. from
the server that actually performed the fetch. This machine's clock is never consulted: those
three fields are the reproducibility record of a fetch this script did not perform, and filling
them in locally would forge provenance. An envelope missing either field is a hard failure.

`limitations` are carried verbatim, in the order the envelopes were given, and land under
`source.limitations`: the snapshot's root sets additionalProperties:false, while the nested
objects do not, so `source` is the only honest home for them. Nothing is rewritten or merged;
the assembler only ever appends its own findings as further entries.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "public-content-snapshot.v1"

# The snapshot's own source enum. NOT the AccountReviewReport one
# (owner_connector | provided_export | public_only) - two different vocabularies that look
# alike; this assembler only ever produces public-connector evidence.
SOURCE_MODE = "public_connector"

PLATFORMS = ("youtube", "instagram")

# Exact values accepted only from fields that explicitly declare a video's format. In particular,
# `format_candidate=youtube_short_candidate` is intentionally not read here: that value is derived
# from duration by the research enrichment service and is provisional rather than a Shorts flag.
YOUTUBE_SHORT_FORMATS = frozenset(("youtube_short", "short", "shorts", "short_form", "shortform"))
YOUTUBE_LONG_FORMATS = frozenset(("youtube_long", "long", "long_form", "longform"))

# Metric name -> the keys an envelope may carry it under. First hit wins, and the key that hit
# becomes `native_name`: the name as it appeared in the envelope, never a translated one.
METRIC_ALIASES: dict[str, tuple[str, ...]] = {
    "views": ("views", "viewCount", "view_count", "play_count", "video_play_count", "video_view_count"),
    "likes": ("likes", "likeCount", "like_count"),
    "comments": ("commentCount", "comment_count", "comments"),
}

# Where rows live inside an envelope's `data`. The three shapes the data plane ships today:
# the normalized `rows` block (youtube-public / instagram-discovery), a bare `items` list, and the
# youtube-outlier channel response, whose rows hang under the channel object.
ROW_PATHS: tuple[tuple[str, ...], ...] = (
    ("data", "rows"),
    ("data", "items"),
    ("data", "channel", "videos"),
)

# Substrings that mean "the fetch did not reach the end of the result set". Matched
# case-insensitively against each envelope limitation; any hit forces coverage_complete false.
TRUNCATION_MARKERS = (
    "truncat",
    "cursor",
    "next_max_id",
    "page budget",
    "prefix of the result set",
    "not the whole",
    "time budget",
    "partial",
)

ISO_DURATION = re.compile(r"^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$")
BARE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------


def dig(value: Any, path: tuple[str, ...]) -> Any:
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def as_text(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def first_text(row: dict[str, Any], paths: tuple[tuple[str, ...], ...]) -> str | None:
    for path in paths:
        text = as_text(dig(row, path))
        if text is not None:
            return text
    return None


def as_number(value: Any) -> float | None:
    """A count, or None when the value is not one. Booleans are not counts."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            return float(text)
        except ValueError:
            return None
    return None


def parse_timestamp(value: Any, label: str) -> datetime:
    text = as_text(value)
    if text is None:
        raise ValueError(f"{label} must be a timestamp, got {value!r}")
    if text.isdigit():  # epoch seconds, as Instagram's taken_at reports them
        return datetime.fromtimestamp(int(text), tz=timezone.utc)
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone: {text}")
    return parsed.astimezone(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def duration_seconds(row: dict[str, Any]) -> float | None:
    """Seconds, from whichever shape the provider used, or None if it said nothing.

    ("snippet", "duration") is the youtube-outlier shape: plain integer seconds, nested where
    its identity fields live. Its absence once marked 115 real items youtube_long "without a
    duration signal" while every row carried one - when a source nests identity under a key,
    expect its numbers under that key too.
    """
    for path in (("duration_seconds",), ("duration",), ("video_duration",), ("length_seconds",),
                 ("snippet", "duration"), ("contentDetails", "duration"), ("content_details", "duration")):
        raw = dig(row, path)
        number = as_number(raw)
        if number is not None:
            return number
        text = as_text(raw)
        if text is None:
            continue
        match = ISO_DURATION.match(text)  # ISO-8601, as contentDetails.duration reports it
        if match:
            hours, minutes, seconds = match.groups()
            return float(hours or 0) * 3600 + float(minutes or 0) * 60 + float(seconds or 0)
    return None


# ---------------------------------------------------------------------------
# envelope -> item
# ---------------------------------------------------------------------------


def metrics_of(row: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """views / likes / comments as {status, value, native_name}.

    `status` follows the snapshot enum: available / zero / unavailable / error. A key that is
    absent is `unavailable` with a null value - never 0, because "nobody reported it" and
    "nobody watched it" are different facts and the analyzer treats only the second as data.
    A present but unusable value (non-numeric, negative) is `error`, which keeps the fact that
    the provider answered while refusing to hand a bad number to the analyzer.
    """
    metrics: dict[str, dict[str, Any]] = {}
    # Sources disagree on where the counters nest: youtube-public style rows use "metrics",
    # while youtube-outlier puts the same viewCount/likeCount/commentCount names under
    # "statistics".
    # Consulting only one of them silently downgraded 65/75 real rows to `unavailable`
    # while the numbers sat right there - the identity lookups already read the snippet
    # nest, and the counters get the same treatment.
    nested_sources = [row[key] for key in ("metrics", "statistics") if isinstance(row.get(key), dict)]
    for name, aliases in METRIC_ALIASES.items():
        native = None
        saw_null = False
        saw_invalid = False
        number: float | None = None
        for alias in aliases:
            for source in (*nested_sources, row):
                if alias in source:
                    candidate = source[alias]
                    if candidate is None:
                        native = native or alias
                        saw_null = True
                        continue
                    parsed = as_number(candidate)
                    if parsed is None or parsed < 0 or parsed != parsed \
                            or parsed in (float("inf"), float("-inf")):
                        native = native or alias
                        saw_invalid = True
                        continue
                    native, number = alias, parsed
                    break
            if number is not None:
                break
        if native is None:
            metrics[name] = {"status": "unavailable", "value": None, "native_name": name}
            continue
        if number is None and saw_null and not saw_invalid:
            metrics[name] = {"status": "unavailable", "value": None, "native_name": native}
            continue
        if number is None:
            metrics[name] = {"status": "error", "value": None, "native_name": native}
            continue
        metrics[name] = {
            "status": "zero" if number == 0 else "available",
            "value": number,
            "native_name": native,
        }
    return metrics


def unwrap(row: dict[str, Any]) -> dict[str, Any]:
    """instagram-discovery reel rows arrive wrapped as {"media": {...}}; unwrap once, never deeper."""
    media = row.get("media")
    if isinstance(media, dict) and "id" not in row and "pk" not in row and "code" not in row:
        return media
    return row


def creator_of(row: dict[str, Any], platform: str) -> tuple[str, dict[str, Any]] | None:
    if platform == "youtube":
        creator_id = first_text(row, (("channel_id",), ("channelId",), ("snippet", "channelId")))
        if creator_id is None:
            return None
        handle = first_text(row, (("channel_title",), ("channelTitle",), ("snippet", "channelTitle"))) or creator_id
        return creator_id, {
            "creator_id": creator_id,
            "handle": handle,
            "source_url": f"https://www.youtube.com/channel/{creator_id}",
        }
    handle = first_text(row, (("user", "username"), ("owner", "username"), ("username",)))
    creator_id = first_text(row, (("user", "pk"), ("user", "id"), ("owner", "pk"), ("owner", "id"))) or handle
    if creator_id is None or handle is None:
        return None
    return creator_id, {
        "creator_id": creator_id,
        "handle": handle,
        "source_url": f"https://www.instagram.com/{handle}/",
    }


def content_id_of(row: dict[str, Any], platform: str) -> str | None:
    if platform == "youtube":
        return first_text(row, (("content_id",), ("id",), ("video_id",), ("videoId",), ("id", "videoId")))
    return first_text(row, (("code",), ("shortcode",), ("content_id",), ("pk",), ("id",), ("media_id",)))


def instagram_format_of(row: dict[str, Any]) -> str:
    """Keep Reels and Feed posts as separate comparable cohorts."""
    product = (first_text(row, (("product_type",), ("media_product_type",))) or "").lower()
    media_type = as_number(dig(row, ("media_type",)))
    if product in ("clips", "reels", "reel", "igtv") or media_type == 2.0:
        return "instagram_reel"
    return "instagram_feed"


def url_of(row: dict[str, Any], platform: str, content_id: str) -> str:
    """The row's own URL, or the platform's canonical form of the id the provider returned.

    Constructing from a returned id is what the connectors themselves already do; what is
    forbidden is inventing a URL for a row that carries no id, and such rows are skipped
    before this is ever called.
    """
    given = first_text(row, (("source_url",), ("url",), ("permalink",), ("permalink_url",)))
    if given is not None:
        return given
    if platform == "youtube":
        return f"https://www.youtube.com/watch?v={content_id}"
    path = "reel" if instagram_format_of(row) == "instagram_reel" else "p"
    return f"https://www.instagram.com/{path}/{content_id}/"


def format_of(row: dict[str, Any], platform: str, url: str) -> tuple[str, bool]:
    """(format, format_unknown). Duration is never a reliable YouTube format signal."""
    if platform == "instagram":
        return instagram_format_of(row), False

    # Prefer a provider's explicit boolean over every derived or URL-shaped signal. Only real
    # booleans count: accepting 0/1 or truthy strings here would turn an untyped provider quirk into
    # an authoritative cohort label.
    for path in (
        ("is_short",), ("isShort",), ("short",),
        ("snippet", "is_short"), ("snippet", "isShort"),
        ("contentDetails", "isShort"), ("content_details", "is_short"),
    ):
        declared = dig(row, path)
        if isinstance(declared, bool):
            return ("youtube_short" if declared else "youtube_long"), False

    # A provider may expose the same declaration as a small enum. Read only format-specific field
    # names and exact known values; generic `type=video` and provisional `format_candidate` are not
    # evidence of Short versus long-form.
    for path in (
        ("format",), ("content_format",), ("video_format",), ("video_type",),
        ("snippet", "format"), ("snippet", "content_format"),
    ):
        declared = as_text(dig(row, path))
        if declared is None:
            continue
        normalized = re.sub(r"[\s-]+", "_", declared.lower())
        if normalized in YOUTUBE_SHORT_FORMATS:
            return "youtube_short", False
        if normalized in YOUTUBE_LONG_FORMATS:
            return "youtube_long", False

    # A canonical Shorts route is an explicit platform signal. A /watch URL is not the inverse:
    # YouTube also serves Shorts through /watch, so it cannot prove long-form.
    if re.search(r"/shorts(?:/|$)", url, flags=re.IGNORECASE):
        return "youtube_short", False
    return "unknown", True


def rows_of(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    for path in ROW_PATHS:
        rows = dig(envelope, path)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def coverage_incomplete_signals(
    envelope: dict[str, Any], complete_operations: set[str]
) -> bool:
    if envelope.get("status") == "completed_partial":
        return True
    for text in envelope.get("limitations") or []:
        lowered = str(text).lower()
        if any(marker in lowered for marker in TRUNCATION_MARKERS):
            return True
    data = envelope.get("data")
    if isinstance(data, dict):
        operation_complete = envelope.get("operation") in complete_operations
        if data.get("more_available") is True and not operation_complete:
            return True
        for key in ("cursor", "next_cursor", "next_max_id", "nextPageToken"):
            if as_text(data.get(key)) is not None and not operation_complete:
                return True
        # Discovery providers often return a bounded sample without a pagination attestation.
        # `null` / absent is unknown coverage, not proof that the niche or market was exhausted.
        if envelope.get("operation") == "discover_trending" and data.get("more_available") is not False:
            return True
    return False


# ---------------------------------------------------------------------------
# assembly
# ---------------------------------------------------------------------------


def load_envelope(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path.name}: an envelope must be a JSON object")
    for field in ("connector_id", "retrieved_at", "raw_sha256"):
        if as_text(payload.get(field)) is None:
            raise ValueError(
                f"{path.name}: envelope is missing {field}; observed_at and raw_sha256 must come "
                "from the server that performed the fetch, and cannot be reconstructed here"
            )
    return payload


def window_bounds(raw: str) -> tuple[datetime, datetime]:
    start_raw, separator, end_raw = raw.partition("/")
    if not separator or not start_raw.strip() or not end_raw.strip():
        raise ValueError("--window must be <start>/<end>")
    start = parse_timestamp(
        f"{start_raw.strip()}T00:00:00Z" if BARE_DATE.match(start_raw.strip()) else start_raw.strip(),
        "window start",
    )
    end = parse_timestamp(
        f"{end_raw.strip()}T23:59:59Z" if BARE_DATE.match(end_raw.strip()) else end_raw.strip(),
        "window end",
    )
    if end < start:
        raise ValueError("--window end must not precede its start")
    return start, end


def build(args: argparse.Namespace) -> dict[str, Any]:
    envelopes = [load_envelope(path) for path in args.envelope]
    complete_operations = set(getattr(args, "complete_operation", None) or [])
    available_operations = {
        str(envelope.get("operation")) for envelope in envelopes if envelope.get("operation")
    }
    unknown_complete_operations = complete_operations - available_operations
    if unknown_complete_operations:
        raise ValueError(
            "--complete-operation names operations absent from the supplied envelopes: "
            + ", ".join(sorted(unknown_complete_operations))
        )
    for operation in complete_operations:
        operation_envelopes = [
            envelope for envelope in envelopes if envelope.get("operation") == operation
        ]
        if not any(
            isinstance(envelope.get("data"), dict)
            and envelope["data"].get("more_available") is False
            for envelope in operation_envelopes
        ):
            raise ValueError(
                f"--complete-operation {operation} requires a terminal envelope with more_available=false"
            )
    queries = list(getattr(args, "query", None) or [])
    if queries and len(queries) != len(envelopes):
        raise ValueError("--query must be omitted or repeated exactly once per --envelope, in the same order")
    if not queries:
        queries = [None] * len(envelopes)
    automatic_window = args.window == "auto"
    start, end = (None, None) if automatic_window else window_bounds(args.window)

    connector_ids: list[str] = []
    limitations: list[str] = []
    retrieved: list[datetime] = []
    coverage_complete = not args.coverage_incomplete
    for envelope in envelopes:
        connector_id = str(envelope["connector_id"])
        if connector_id not in connector_ids:
            connector_ids.append(connector_id)
        limitations.extend(str(text) for text in (envelope.get("limitations") or []))
        retrieved.append(parse_timestamp(envelope["retrieved_at"], "retrieved_at"))
        if coverage_incomplete_signals(envelope, complete_operations):
            coverage_complete = False
            if envelope.get("operation") == "discover_trending" \
                    and isinstance(envelope.get("data"), dict) \
                    and envelope["data"].get("more_available") is not False:
                note = "Provider did not attest complete discover_trending coverage"
                if note not in limitations:
                    limitations.append(note)

    observed_at = max(retrieved)
    if end is not None and end > observed_at:
        # The analyzer rejects a window that ends after observed_at, and rightly so: it would
        # claim coverage of time the fetch never saw. Clamp and say so, instead of failing on
        # the common "--window ...\today" call.
        limitations.append(f"Window end clamped to the retrieval time: {iso(observed_at)}")
        end = observed_at
        if end < start:
            raise ValueError("the window starts after the data was retrieved; nothing can be assembled")

    primary = args.primary_connector or connector_ids[0]
    if primary not in connector_ids:
        connector_ids.insert(0, primary)
    others = [connector_id for connector_id in connector_ids if connector_id != primary]
    if others:
        # `source.connector_id` is a single string upstream while every evidence plan spans two
        # or more connectors. The rest are reported rather than dropped, in the given order.
        limitations.append("Additional connectors used: " + ", ".join(others))

    creators: dict[str, dict[str, Any]] = {}
    items: dict[str, dict[str, Any]] = {}
    input_rows = 0
    skipped_unidentifiable = 0
    skipped_missing_content_id = 0
    skipped_missing_creator = 0
    skipped_missing_publish_time = 0
    skipped_non_reel = 0
    duplicate_rows_merged = 0
    format_unknown = 0

    for envelope, query in zip(envelopes, queries):
        for raw_row in rows_of(envelope):
            input_rows += 1
            row = unwrap(raw_row)
            content_id = content_id_of(row, args.platform)
            creator = creator_of(row, args.platform)
            published = dig(row, ("published_at",)) or dig(row, ("publishedAt",)) \
                or dig(row, ("snippet", "publishedAt")) or dig(row, ("taken_at",)) \
                or dig(row, ("taken_at_timestamp",)) or dig(row, ("timestamp",))
            if content_id is None:
                skipped_missing_content_id += 1
            if creator is None:
                skipped_missing_creator += 1
            if published is None:
                skipped_missing_publish_time += 1
            if content_id is None or creator is None or published is None:
                skipped_unidentifiable += 1
                continue
            creator_id, creator_row = creator
            creators.setdefault(creator_id, creator_row)
            url = url_of(row, args.platform, content_id)
            content_format, unknown = format_of(row, args.platform, url)
            item = {
                "content_id": content_id,
                "creator_id": creator_id,
                "url": url,
                "title": first_text(row, (("title",), ("snippet", "title"), ("caption", "text"), ("caption",)))
                         or "(untitled)",
                "published_at": iso(parse_timestamp(published, f"{content_id}.published_at")),
                "format": content_format,
                "metrics": metrics_of(row),
            }
            if query:
                item["query_refs"] = [query]
            seconds = duration_seconds(row)
            if seconds is not None:
                item["duration_seconds"] = seconds
            if content_id in items:
                duplicate_rows_merged += 1
                # The same content reached us through two connectors. The analyzer raises on
                # duplicates that disagree, so they are merged here: first envelope wins, later
                # ones only fill metrics the first could not report.
                existing = items[content_id]
                for name, entry in item["metrics"].items():
                    if existing["metrics"][name]["status"] in ("unavailable", "error") \
                            and entry["status"] in ("available", "zero"):
                        existing["metrics"][name] = entry
                if query:
                    existing["query_refs"] = sorted(set(existing.get("query_refs", []) + [query]))
                continue
            if unknown:
                format_unknown += 1
            items[content_id] = item

    if skipped_unidentifiable:
        limitations.append(
            f"Skipped {skipped_unidentifiable} row(s) with no resolvable content id, creator or publish time"
        )
    if skipped_non_reel:
        limitations.append(f"Skipped {skipped_non_reel} Instagram row(s) the provider marked as not a reel")
    if format_unknown:
        limitations.append(
            f"No explicit provider format or Shorts URL signal for {format_unknown} YouTube item(s): "
            "recorded as unknown and excluded from YouTube Short/long cohort comparisons"
        )
    if not items:
        raise ValueError(
            "no item survived assembly; the envelopes carry no rows this assembler can read - "
            "check that they are data_connector_run responses for the platform given"
        )

    if automatic_window:
        published = [parse_timestamp(item["published_at"], "published_at") for item in items.values()]
        start, end = min(published), max(published)

    if start is None or end is None:
        raise ValueError("window bounds could not be determined")

    # Aggregated in the order the envelopes were given, and hashed even when there is only one,
    # so the value always means "digest over this snapshot's inputs, in order" and never
    # doubles as a single provider payload's digest.
    raw_sha256 = hashlib.sha256(
        "\n".join(str(envelope["raw_sha256"]) for envelope in envelopes).encode("utf-8")
    ).hexdigest()
    snapshot_id = "public-content-snapshot-" + hashlib.sha256(
        f"{args.platform}:{iso(start)}:{iso(end)}:{raw_sha256}".encode("utf-8")
    ).hexdigest()[:16]

    scope: dict[str, Any] = {"window": {"start": iso(start), "end": iso(end)}}
    unique_queries = list(dict.fromkeys(query for query in queries if query))
    if unique_queries:
        scope["queries"] = unique_queries
    if getattr(args, "region", None) is not None:
        scope["region"] = args.region
    if getattr(args, "language", None) is not None:
        scope["language"] = args.language

    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_id": snapshot_id,
        "observed_at": iso(observed_at),
        "platform": args.platform,
        "scope": scope,
        "source": {
            "source_mode": SOURCE_MODE,
            "connector_id": primary,
            "retrieved_at": iso(min(retrieved)),
            "raw_sha256": raw_sha256,
            "coverage_complete": coverage_complete,
            "pagination": {
                "input_rows": input_rows,
                "normalized_items": len(items),
                "duplicate_rows_merged": duplicate_rows_merged,
                "skipped_unidentifiable": skipped_unidentifiable,
                "skipped_missing_content_id": skipped_missing_content_id,
                "skipped_missing_creator": skipped_missing_creator,
                "skipped_missing_publish_time": skipped_missing_publish_time,
                "skipped_non_reel": skipped_non_reel,
                "format_unknown": format_unknown,
            },
            "limitations": limitations,
        },
        "creators": sorted(creators.values(), key=lambda row: row["creator_id"]),
        "items": sorted(items.values(), key=lambda row: (row["published_at"], row["content_id"])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble public-content-snapshot.v1 from connector envelopes")
    parser.add_argument("--envelope", type=Path, action="append", required=True,
                        help="a data_connector_run envelope, as JSON; repeatable, order is the aggregation order")
    parser.add_argument("--platform", choices=PLATFORMS, required=True)
    parser.add_argument(
        "--window",
        required=True,
        help="<start>/<end>, dates or timestamps; use auto only when the user did not request a window",
    )
    parser.add_argument("--query", action="append",
                        help="query that produced the matching --envelope; repeat in envelope order")
    parser.add_argument("--region", help="requested region, preserved in snapshot scope")
    parser.add_argument("--language", help="requested language, preserved in snapshot scope")
    parser.add_argument("--primary-connector", help="defaults to the first envelope's connector_id")
    parser.add_argument("--coverage-incomplete", action="store_true",
                        help="force coverage_complete false; there is deliberately no flag that forces it true")
    parser.add_argument(
        "--complete-operation",
        action="append",
        choices=("list_posts", "list_reels", "list_channel_uploads"),
        help=(
            "repeat only when every pagination chain for this operation reached a persisted "
            "terminal envelope with more_available=false; intermediate cursors then do not "
            "make coverage incomplete"
        ),
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        snapshot = build(args)
        text = json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        print(json.dumps({
            "status": "ok",
            "path": str(args.output),
            "snapshot_id": snapshot["snapshot_id"],
            "item_count": len(snapshot["items"]),
            "creator_count": len(snapshot["creators"]),
            "coverage_complete": snapshot["source"]["coverage_complete"],
        }, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "failed", "error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

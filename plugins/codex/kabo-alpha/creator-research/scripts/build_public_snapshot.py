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

`items[].format` is narrowed to youtube_short / youtube_long / instagram_reel even though the
snapshot schema declares plain {"type": "string"} for it. The narrowing is deliberate and is
Kabo's, not upstream's: it is exactly the content-format enum the Kabo server uses for creator
observations, so the day these items are normalized into observations there is nothing left to
translate. Ranking never mixes formats, so a wrong label is a wrong cohort, not a cosmetic
defect.

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

# YouTube Shorts eligibility line since 2024-10. Used only when the envelope carries a real
# duration; it is a threshold on provider data, not a guess about the content.
SHORT_MAX_SECONDS = 180

# Metric name -> the keys an envelope may carry it under. First hit wins, and the key that hit
# becomes `native_name`: the name as it appeared in the envelope, never a translated one.
METRIC_ALIASES: dict[str, tuple[str, ...]] = {
    "views": ("views", "viewCount", "view_count", "play_count", "video_play_count", "video_view_count"),
    "likes": ("likes", "likeCount", "like_count"),
    "comments": ("comments", "commentCount", "comment_count"),
}

# Where rows live inside an envelope's `data`. The three shapes the data plane ships today:
# the normalized `rows` block (YouTube / ScrapeCreators), a bare `items` list, and TubeLab's
# channel response, whose rows hang under the channel object.
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
    """Seconds, from whichever of the three shapes the provider used, or None if it said nothing."""
    for path in (("duration_seconds",), ("duration",), ("video_duration",), ("length_seconds",),
                 ("contentDetails", "duration"), ("content_details", "duration")):
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
    nested = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
    for name, aliases in METRIC_ALIASES.items():
        native = None
        raw: Any = None
        for alias in aliases:
            if alias in nested:
                native, raw = alias, nested[alias]
                break
            if alias in row:
                native, raw = alias, row[alias]
                break
        if native is None:
            metrics[name] = {"status": "unavailable", "value": None, "native_name": name}
            continue
        if raw is None:
            metrics[name] = {"status": "unavailable", "value": None, "native_name": native}
            continue
        number = as_number(raw)
        if number is None or number < 0 or number != number or number in (float("inf"), float("-inf")):
            metrics[name] = {"status": "error", "value": None, "native_name": native}
            continue
        metrics[name] = {
            "status": "zero" if number == 0 else "available",
            "value": number,
            "native_name": native,
        }
    return metrics


def unwrap(row: dict[str, Any]) -> dict[str, Any]:
    """ScrapeCreators reel rows arrive wrapped as {"media": {...}}; unwrap once, never deeper."""
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
    return f"https://www.instagram.com/reel/{content_id}/"


def format_of(row: dict[str, Any], platform: str, url: str) -> tuple[str, bool]:
    """(format, inferred_without_duration). See the module docstring for why the enum is narrow."""
    if platform == "instagram":
        return "instagram_reel", False
    seconds = duration_seconds(row)
    if seconds is not None:
        return ("youtube_short" if seconds <= SHORT_MAX_SECONDS else "youtube_long"), False
    if "/shorts/" in url:
        return "youtube_short", False
    return "youtube_long", True


def is_non_reel(row: dict[str, Any]) -> bool:
    """Instagram rows the provider itself marks as something other than a reel.

    A photo or carousel counted inside a reel cohort moves the median it is compared against,
    so it is dropped and reported rather than relabelled.
    """
    product = (first_text(row, (("product_type",), ("media_product_type",))) or "").lower()
    if product and product not in ("clips", "reels", "reel", "igtv"):
        return True
    media_type = as_number(dig(row, ("media_type",)))
    return media_type is not None and media_type not in (2.0,)  # 2 = video, the only reel carrier


def rows_of(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    for path in ROW_PATHS:
        rows = dig(envelope, path)
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


def coverage_incomplete_signals(envelope: dict[str, Any]) -> bool:
    if envelope.get("status") == "completed_partial":
        return True
    for text in envelope.get("limitations") or []:
        lowered = str(text).lower()
        if any(marker in lowered for marker in TRUNCATION_MARKERS):
            return True
    data = envelope.get("data")
    if isinstance(data, dict):
        if data.get("more_available") is True:
            return True
        for key in ("cursor", "next_cursor", "next_max_id", "nextPageToken"):
            if as_text(data.get(key)) is not None:
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
    start, end = window_bounds(args.window)

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
        if coverage_incomplete_signals(envelope):
            coverage_complete = False

    observed_at = max(retrieved)
    if end > observed_at:
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
    skipped_unidentifiable = 0
    skipped_non_reel = 0
    format_inferred = 0

    for envelope in envelopes:
        for raw_row in rows_of(envelope):
            row = unwrap(raw_row)
            if args.platform == "instagram" and is_non_reel(row):
                skipped_non_reel += 1
                continue
            content_id = content_id_of(row, args.platform)
            creator = creator_of(row, args.platform)
            published = dig(row, ("published_at",)) or dig(row, ("publishedAt",)) \
                or dig(row, ("snippet", "publishedAt")) or dig(row, ("taken_at",)) \
                or dig(row, ("taken_at_timestamp",)) or dig(row, ("timestamp",))
            if content_id is None or creator is None or published is None:
                skipped_unidentifiable += 1
                continue
            creator_id, creator_row = creator
            creators.setdefault(creator_id, creator_row)
            url = url_of(row, args.platform, content_id)
            content_format, inferred = format_of(row, args.platform, url)
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
            seconds = duration_seconds(row)
            if seconds is not None:
                item["duration_seconds"] = seconds
            if content_id in items:
                # The same content reached us through two connectors. The analyzer raises on
                # duplicates that disagree, so they are merged here: first envelope wins, later
                # ones only fill metrics the first could not report.
                existing = items[content_id]
                for name, entry in item["metrics"].items():
                    if existing["metrics"][name]["status"] in ("unavailable", "error") \
                            and entry["status"] in ("available", "zero"):
                        existing["metrics"][name] = entry
                continue
            if inferred:
                format_inferred += 1
            items[content_id] = item

    if skipped_unidentifiable:
        limitations.append(
            f"Skipped {skipped_unidentifiable} row(s) with no resolvable content id, creator or publish time"
        )
    if skipped_non_reel:
        limitations.append(f"Skipped {skipped_non_reel} Instagram row(s) the provider marked as not a reel")
    if format_inferred:
        limitations.append(
            f"Format inferred without a duration signal for {format_inferred} item(s): recorded as youtube_long"
        )
    if not items:
        raise ValueError(
            "no item survived assembly; the envelopes carry no rows this assembler can read - "
            "check that they are data_connector_run responses for the platform given"
        )

    # Aggregated in the order the envelopes were given, and hashed even when there is only one,
    # so the value always means "digest over this snapshot's inputs, in order" and never
    # doubles as a single provider payload's digest.
    raw_sha256 = hashlib.sha256(
        "\n".join(str(envelope["raw_sha256"]) for envelope in envelopes).encode("utf-8")
    ).hexdigest()
    snapshot_id = "public-content-snapshot-" + hashlib.sha256(
        f"{args.platform}:{iso(start)}:{iso(end)}:{raw_sha256}".encode("utf-8")
    ).hexdigest()[:16]

    return {
        "schema_version": SCHEMA_VERSION,
        "snapshot_id": snapshot_id,
        "observed_at": iso(observed_at),
        "platform": args.platform,
        "scope": {"window": {"start": iso(start), "end": iso(end)}},
        "source": {
            "source_mode": SOURCE_MODE,
            "connector_id": primary,
            "retrieved_at": iso(min(retrieved)),
            "raw_sha256": raw_sha256,
            "coverage_complete": coverage_complete,
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
    parser.add_argument("--window", required=True, help="<start>/<end>, dates or timestamps")
    parser.add_argument("--primary-connector", help="defaults to the first envelope's connector_id")
    parser.add_argument("--coverage-incomplete", action="store_true",
                        help="force coverage_complete false; there is deliberately no flag that forces it true")
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

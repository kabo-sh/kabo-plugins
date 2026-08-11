#!/usr/bin/env node
// Kabo local Connector MCP server - the third-party data layer for the creator-research skill.
//
// Why a local server instead of a cloud tool:
//   The provider's quota and billing belong to the user's own account; the platform does not hold
//   third-party credentials on their behalf. The user fills the key in the plugin config, and it is
//   injected into this process's environment via ${user_config.*} in .mcp.json.
//
// Why the key travels through the MCP server's env instead of the Bash environment:
//   The host exports CLAUDE_PLUGIN_OPTION_* only to **hook processes**, and a skill is invoked by
//   skill-runner through Bash, so it never sees them; the host also explicitly forbids interpolating
//   ${user_config.*} into shell commands (the value would be executed by the shell). An MCP stdio
//   server's env is the only channel that both receives the value and bypasses the shell.
//
// Hard rules:
//   - A missing key always returns blocked_setup; never substitute another data source, never fabricate (matches the V1 contract)
//   - The key's value is used only inside this process to build the Authorization header; it never enters inputs, outputs, logs, or error messages
//   - Outputs keep V1's result envelope semantics: status / limitations / provider must be truthful
// Zero dependencies: per contract §7 the plugin stays pure JS with no build step and no npm
// dependencies, so the MCP stdio transport (newline-delimited JSON-RPC 2.0) is hand-written here
// rather than pulled from the SDK.
import readline from "node:readline";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Keys the user fills in via the plugin config. A missing key means blocked_setup, not failure.
 * Only providers that are **actually read** are listed: declaring a key no code path reads would
 * make the user store a useless credential in the keychain (which shares roughly 2KB with the OAuth
 * token) and mislead them into thinking the feature works.
 * The gemini / scrapecreators keys come back when their connectors land.
 */
const KEYS = {
  tubelab: { env: "TUBELAB_API_KEY", option: "tubelab_api_key", provider: "TubeLab" },
  youtube: { env: "YOUTUBE_API_KEY", option: "youtube_api_key", provider: "YouTube Data API" },
  gemini: { env: "GEMINI_API_KEY", option: "gemini_api_key", provider: "Google Gemini" },
  scrapecreators: {
    env: "SCRAPECREATORS_API_KEY", option: "scrapecreators_api_key", provider: "ScrapeCreators",
  },
};

function keyFor(name) {
  const raw = process.env[KEYS[name].env];
  // When ${user_config.x} is unconfigured the host may leave the template string as-is; treat that as unconfigured
  if (typeof raw !== "string" || raw.trim() === "" || /^\$\{.*\}$/.test(raw)) return null;
  return raw.trim();
}

/** Unified output. Apart from data, the fields are a subset of the V1 result envelope, semantics preserved verbatim. */
function envelope({ connector, operation, provider, status, summary, data = null, limitations = [] }) {
  const body = {
    schema_version: "1.0",
    connector_id: connector,
    operation,
    provider,
    status,
    summary,
    limitations,
    // Same meaning as V1: confirms credential values never entered the result
    credential_values_recorded: false,
    ...(data === null ? {} : { data }),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    // blocked_setup / unsupported are not tool failures, but the model must see that this is an exceptional path
    ...(status === "completed" ? {} : { isError: true }),
  };
}

function blocked(name, operation) {
  const { option, provider, env } = KEYS[name];
  return envelope({
    connector: `${name}-connector`,
    operation,
    provider,
    status: "blocked_setup",
    summary:
      `No API key is configured for ${provider}, so no data can be fetched. In Claude Code run ` +
      `\`/plugin\` and re-enable kabo-alpha to trigger the config prompt, then fill in "${option}" ` +
      `(password field; the value is stored in the system keychain). The key runs against your own account and quota.`,
    limitations: [
      `${env} is missing; no ${provider} data was retrieved this run.`,
      "Do not substitute another data source or prior knowledge and then claim this skill ran.",
    ],
  });
}

/** JSON fetch with a timeout and a size cap. The key is never echoed in error messages. */
async function fetchJson(url, headers, provider) {
  const controller = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, { headers, signal: controller });
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${provider} response exceeded the ${MAX_RESPONSE_BYTES}-byte cap`);
  }
  if (!res.ok) {
    // The provider's error body may echo request parameters, so take only the status code
    throw new Error(`${provider} returned HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${provider} did not return valid JSON`);
  }
}

/* ---------- External binaries: detection and invocation ----------
 * V1's public-video-media and scrapecreators connectors are themselves adapters over external
 * commands (yt-dlp/ffmpeg, a pinned scrapecreators CLI), and the HTTP details live inside those
 * commands. The faithful port calls them the same way rather than guessing the provider's endpoints
 * and rewriting everything here. */

/** A missing binary is not a failure, it is an environment that is not ready - report blocked_setup and say exactly what to install. */
function blockedBinary(connector, operation, provider, missing, howto) {
  return envelope({
    connector,
    operation,
    provider,
    status: "blocked_setup",
    summary: `This machine is missing ${missing.join(", ")}, so ${operation} cannot run.`,
    limitations: [
      `Install it first: ${howto}`,
      "Do not substitute another data source or prior knowledge and then claim this step completed.",
    ],
  });
}

function which(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Pass proxy config through: minimizing env once stripped the proxy variables as well, so on a
 * proxied network every subprocess-based connector failed to fetch data. A proxy address is not a
 * credential, so passing it through does not violate the leak-prevention intent; both casings are
 * included (Go and Python read them differently); NO_PROXY must be included, otherwise intranet
 * addresses would be wrongly pushed through the proxy.
 */
const PROXY_ENV_VARS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

function proxyEnv() {
  const out = {};
  for (const name of PROXY_ENV_VARS) {
    const v = process.env[name];
    if (typeof v === "string" && v !== "") out[name] = v;
  }
  return out;
}

/**
 * Text may enter outbound error messages only after known sensitive values are wiped: each provider
 * key (a subprocess may splice it into a URL and echo it back) and proxy URLs (which may contain
 * user:pass).
 */
function redactSecrets(text) {
  let out = text;
  for (const name of Object.keys(KEYS)) {
    const v = keyFor(name);
    if (v) out = out.split(v).join("***");
  }
  for (const v of Object.values(proxyEnv())) {
    out = out.split(v).join("***");
  }
  return out;
}

/**
 * Run an external command and take its stdout.
 * The key is passed to the child process via env and **never in argv** - argv is visible in /proc
 * to any process on the machine.
 * Error messages carry the command name, the precise exit reason (timeout / signal / exit code) and
 * a **redacted** stderr tail - passing nothing through used to render a timeout as "exit code
 * unknown", which pointed debugging in the wrong direction.
 */
function runCommand(bin, argv, { env = {}, timeoutMs = TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      argv,
      {
        timeout: timeoutMs,
        maxBuffer: maxBytes,
        encoding: "buffer",
        // Minimize the child environment: do not pass all of process.env through, so unrelated credentials never reach external commands
        env: { PATH: process.env.PATH || "", HOME: process.env.HOME || os.tmpdir(), LANG: "C.UTF-8", ...proxyEnv(), ...env },
      },
      (err, stdout, stderr) => {
        if (err) {
          const tail = redactSecrets((stderr ? stderr.toString("utf8") : ""))
            .replace(/\s+/g, " ").trim().slice(-200);
          const suffix = tail ? `; stderr tail: ${tail}` : "";
          if (err.killed && err.signal) {
            reject(new Error(`${path.basename(bin)} did not finish within ${timeoutMs}ms and was killed on timeout${suffix}`));
            return;
          }
          const code = typeof err.code === "number" ? err.code : err.signal || err.code || "unknown";
          reject(new Error(`${path.basename(bin)} exited with code ${code}${suffix}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseJsonBuffer(buf, provider) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error(`${provider} did not return valid JSON`);
  }
}

/** Each call gets its own working directory, and artifact paths are returned to the model; nothing is written to the skill cache or the plugin directory. */
function runDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kabo-${prefix}-`));
}

const TOOLS = [];
const HANDLERS = new Map();

/** Register a tool. The schema is plain JSON Schema - no zod, and none needed. */
function registerTool(name, { description, inputSchema }, handler) {
  TOOLS.push({ name, description, inputSchema });
  HANDLERS.set(name, handler);
}

const server = { registerTool };

/* ---------- TubeLab: channel-relative outliers and channel videos ---------- */

server.registerTool(
  "connector_tubelab_search_outliers",
  {
    description:
      "TubeLab outlier search: given 1-4 query terms, find recent YouTube videos performing far above their channel's baseline (sorted by zScore). " +
      "Use it for topic research and competitor discovery. Requires a user-supplied TubeLab API key.",
    inputSchema: {
      type: "object",
      required: ["queries"],
      properties: {
        queries: {
          type: "array", minItems: 1, maxItems: 4,
          items: { type: "string", minLength: 1 },
          description: "1-4 query terms",
        },
        lookback_days: { type: "integer", minimum: 1, maximum: 365, description: "Lookback window in days, default 30" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Number of results, default 20" },
        min_views: { type: "integer", minimum: 0, description: "Minimum view count, default 5000" },
        language: { type: "string", description: "Language code, default en" },
        region_code: { type: "string", description: "Region code (note: this endpoint does not apply strict region filtering)" },
      },
    },
  },
  async (args) => {
    const key = keyFor("tubelab");
    if (!key) return blocked("tubelab", "search_outliers");

    const days = args.lookback_days ?? 30;
    const publishedAfter = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10) + "T00:00:00Z";
    const qs = new URLSearchParams([
      ["type", "video"],
      ["language", args.language ?? "en"],
      ["publishedAtFrom", publishedAfter],
      ["viewCountFrom", String(args.min_views ?? 5000)],
      ["size", String(args.limit ?? 20)],
      ["sortBy", "zScore"],
      ["sortOrder", "desc"],
    ]);
    for (const q of args.queries) qs.append("query", q.trim());

    const limitations = [];
    if (args.region_code) {
      // Disclosure kept verbatim from V1: passing a region does not enforce filtering, and staying silent would make users misread the results
      limitations.push(
        "The TubeLab outlier endpoint offers no strict region filtering, so region_code is not enforced.",
      );
    }

    try {
      const payload = await fetchJson(
        `https://public-api.tubelab.net/v1/search/outliers?${qs}`,
        { Authorization: `Api-Key ${key}`, Accept: "application/json" },
        "TubeLab",
      );
      const rows = Array.isArray(payload?.hits) ? payload.hits : [];
      return envelope({
        connector: "tubelab-connector",
        operation: "search_outliers",
        provider: "TubeLab",
        status: "completed",
        summary: `Retrieved ${rows.length} outliers (${days}-day lookback)`,
        data: { rows, count: rows.length, window_days: days, queries: args.queries },
        limitations,
      });
    } catch (err) {
      return envelope({
        connector: "tubelab-connector",
        operation: "search_outliers",
        provider: "TubeLab",
        status: "failed",
        summary: `TubeLab data fetching failed: ${err.message}`,
        limitations: ["No data was retrieved this run; do not substitute prior knowledge and then claim a search was performed."],
      });
    }
  },
);

server.registerTool(
  "connector_tubelab_channel_videos",
  {
    description:
      "TubeLab channel videos: fetch a given YouTube channel's video list and its performance relative to baseline. Requires a user-supplied TubeLab API key.",
    inputSchema: {
      type: "object",
      required: ["channel_id"],
      properties: {
        channel_id: {
          type: "string", pattern: "^UC[\\w-]{22}$",
          description: "YouTube channel ID (starts with UC, 24 characters total)",
        },
      },
    },
  },
  async (args) => {
    if (!/^UC[\w-]{22}$/.test(String(args.channel_id ?? ""))) {
      return envelope({
        connector: "tubelab-connector", operation: "get_channel_videos",
        provider: "TubeLab", status: "failed",
        summary: "channel_id must be a 24-character YouTube channel ID starting with UC",
      });
    }
    const key = keyFor("tubelab");
    if (!key) return blocked("tubelab", "get_channel_videos");
    try {
      const payload = await fetchJson(
        `https://public-api.tubelab.net/v1/channel/videos/${encodeURIComponent(args.channel_id)}`,
        { Authorization: `Api-Key ${key}`, Accept: "application/json" },
        "TubeLab",
      );
      const item = payload?.item ?? {};
      const videos = Array.isArray(item.videos) ? item.videos : [];
      return envelope({
        connector: "tubelab-connector",
        operation: "get_channel_videos",
        provider: "TubeLab",
        status: "completed",
        summary: `Retrieved ${videos.length} videos for channel ${args.channel_id}`,
        data: { channel: item, count: videos.length },
      });
    } catch (err) {
      return envelope({
        connector: "tubelab-connector",
        operation: "get_channel_videos",
        provider: "TubeLab",
        status: "failed",
        summary: `TubeLab data fetching failed: ${err.message}`,
        limitations: ["No data was retrieved this run; do not substitute prior knowledge and then claim a search was performed."],
      });
    }
  },
);

/* ---------- YouTube: via the pinned youtube-pp-cli ----------
 * Verbatim match with V1: same CLI, same set of common flags, same four operations, same
 * normalized_youtube_rows normalization. Not switched to calling the Data API directly - that would
 * save one install step but bypass the CLI's quota accounting and data-source constraints, and the
 * output would no longer be the shape V1 validated.
 * The CLI is an Apache-2.0 Go program the user installs themselves (see the blocked message). */

const YTPP_COMMON = ["--json", "--no-input", "--no-color", "--yes", "--data-source", "live"];

/** Verbatim counterpart of V1's normalized_youtube_rows. */
function normalizedYoutubeRows(operation, payload) {
  if (operation === "list_comments" && payload && typeof payload === "object") {
    const videoId = payload.videoId;
    const rows = (Array.isArray(payload.comments) ? payload.comments : [])
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        id: row.commentId ?? null,
        author: row.author ?? null,
        author_url: row.authorChannelUrl ?? null,
        text: row.text ?? null,
        published_at: row.publishedAt ?? null,
        updated_at: row.updatedAt ?? null,
        metrics: { likes: row.likeCount ?? null, replies: row.replyCount ?? null },
        source_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      }));
    return { rows, count: rows.length, page: { fetched_pages: payload.fetchedPages ?? null } };
  }

  const body = payload && typeof payload === "object" && payload.results !== undefined ? payload.results : payload;
  const items = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : []);
  const rows = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet : {};
    const stats = item.statistics && typeof item.statistics === "object" ? item.statistics : {};
    let identifier = item.id;
    if (identifier && typeof identifier === "object") {
      identifier = identifier.videoId || identifier.channelId || identifier.playlistId || null;
    }
    const kind = item.kind
      ?? (item.id && typeof item.id === "object" ? item.id.kind : null)
      ?? null;
    let sourceUrl = null;
    if (identifier && (String(kind).toLowerCase().includes("video")
        || operation === "search_videos" || operation === "get_video")) {
      sourceUrl = `https://www.youtube.com/watch?v=${identifier}`;
    } else if (identifier && operation === "get_channel") {
      sourceUrl = `https://www.youtube.com/channel/${identifier}`;
    }
    rows.push({
      id: identifier ?? null,
      kind,
      title: snippet.title ?? null,
      description: snippet.description ?? null,
      published_at: snippet.publishedAt ?? null,
      channel_id: snippet.channelId ?? null,
      channel_title: snippet.channelTitle ?? null,
      source_url: sourceUrl,
      metrics: {
        views: stats.viewCount ?? null,
        likes: stats.likeCount ?? null,
        comments: stats.commentCount ?? null,
        subscribers: stats.subscriberCount ?? null,
        videos: stats.videoCount ?? null,
      },
    });
  }
  return {
    rows,
    count: rows.length,
    provider_meta: payload && typeof payload === "object" ? (payload.meta ?? {}) : {},
  };
}

server.registerTool(
  "connector_youtube_pp",
  {
    description:
      "YouTube public data (via the pinned youtube-pp-cli): search videos, fetch a channel, fetch video details, fetch top comments. " +
      "Requires a user-supplied YouTube Data API key and youtube-pp-cli installed on this machine.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["search_videos", "get_channel", "get_video", "list_comments"] },
        query: { type: "string", description: "Required for search_videos" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "search defaults to 25 (max 50); comments defaults to 20 (max 100)" },
        order: { type: "string", description: "search: date|rating|viewCount|relevance|title; comments: relevance|time" },
        published_after: { type: "string" },
        published_before: { type: "string" },
        region_code: { type: "string" },
        language: { type: "string" },
        channel_id: { type: "string", description: "get_channel: give this or handle, not both" },
        handle: { type: "string", description: "get_channel: give this or channel_id, not both" },
        video_id: { type: "string" },
        video_ids: { type: "array", items: { type: "string" }, description: "get_video accepts a batch" },
      },
    },
  },
  async (args) => {
    const operation = args.operation;
    const key = keyFor("youtube");
    if (!key) return blocked("youtube", operation);
    const bin = which("youtube-pp-cli");
    if (!bin) {
      return blockedBinary("youtube-pp-connector", operation, KEYS.youtube.provider, ["youtube-pp-cli"],
        "npx -y @mvanhorn/printing-press-library install youtube --cli-only (without Node, build it yourself with Go 1.26.5+)");
    }

    let argv;
    if (operation === "search_videos") {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("search_videos is missing query");
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
      const order = args.order ?? "relevance";
      if (!["date", "rating", "viewCount", "relevance", "title"].includes(order)) {
        throw new Error("params.order is not supported");
      }
      argv = ["youtube", "search-list", "--q", query, "--max-results", String(limit),
              "--type", "video", "--order", order, ...YTPP_COMMON];
      for (const [name, flag] of [["published_after", "--published-after"], ["published_before", "--published-before"],
                                  ["region_code", "--region-code"], ["language", "--relevance-language"]]) {
        if (args[name]) argv.push(flag, String(args[name]));
      }
    } else if (operation === "get_channel") {
      const hasId = Boolean(args.channel_id);
      const hasHandle = Boolean(args.handle);
      if (hasId === hasHandle) throw new Error("exactly one of channel_id and handle must be given");
      const selector = hasId ? ["--id", String(args.channel_id)] : ["--for-handle", String(args.handle)];
      argv = ["youtube", "channels-list", ...selector, "--part", "snippet,statistics,contentDetails", ...YTPP_COMMON];
    } else if (operation === "get_video") {
      let ids = args.video_ids ?? args.video_id;
      if (Array.isArray(ids)) {
        if (!ids.length || !ids.every((v) => typeof v === "string" && v.trim())) {
          throw new Error("video_ids must be a non-empty array of strings");
        }
        ids = ids.map((v) => v.trim()).join(",");
      }
      if (typeof ids !== "string" || !ids.trim()) throw new Error("video_id or video_ids is required");
      argv = ["youtube", "videos-list", "--id", ids.trim(),
              "--part", "snippet,statistics,contentDetails", ...YTPP_COMMON];
    } else if (operation === "list_comments") {
      const videoId = String(args.video_id || "").trim();
      if (!videoId) throw new Error("list_comments is missing video_id");
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const order = args.order ?? "relevance";
      if (!["relevance", "time"].includes(order)) throw new Error("params.order must be relevance or time");
      // videoId is a bare positional argument, and a YouTube id may legitimately start with "-",
      // which standard Go flag parsing would swallow as an option. Put the flags first, then the
      // "--" terminator, then the positional; both stdlib flag and cobra honor this.
      argv = ["youtube", "videos-comments", "--top", String(limit), "--order", order, ...YTPP_COMMON, "--", videoId];
    } else {
      throw new Error(`unsupported operation: ${operation}`);
    }

    const { stdout } = await runCommand(bin, argv, { env: { YOUTUBE_API_KEY: key } });
    const payload = parseJsonBuffer(stdout, KEYS.youtube.provider);
    const data = normalizedYoutubeRows(operation, payload);
    return envelope({
      connector: "youtube-pp-connector",
      operation,
      provider: KEYS.youtube.provider,
      status: "completed",
      summary: `YouTube ${operation} returned ${data.count} rows.`,
      data: { ...data, retrieved_at: new Date().toISOString() },
    });
  },
);

/* ---------- public-video-media: local media pipeline (yt-dlp + ffmpeg) ----------
 * Verbatim counterpart of public_video_media in V1's run_connector.py: three operations, the same
 * yt-dlp arguments, the same evenly spaced frame sampling. **No key needed** - it gates on local
 * binaries, not credentials. */

const YTDLP_COMMON = ["--no-warnings", "--no-call-home", "--no-progress"];
const MEDIA = { connector: "public-video-media", provider: "Public video media" };

/** Accept only public http(s) links, blocking things like file:// that would feed local paths to yt-dlp. */
function mediaUrl(raw) {
  const value = String(raw || "").trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("params.url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("params.url accepts only http/https");
  }
  return value;
}

/** WebVTT -> plain text + timestamped cues. Same semantics as V1's parse_vtt_cues. */
function parseVttCues(text) {
  const cues = [];
  const parts = String(text).replace(/\r/g, "").split("\n\n");
  for (const block of parts) {
    const lines = block.split("\n").filter(Boolean);
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;
    const body = lines
      .slice(lines.indexOf(timing) + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .trim();
    if (!body) continue;
    const [start, end] = timing.split("-->").map((t) => t.trim().split(" ")[0]);
    const prev = cues[cues.length - 1];
    if (prev && prev.text === body) continue; // rolling duplication common in auto-generated captions
    cues.push({ start, end, text: body });
  }
  return { transcript: cues.map((c) => c.text).join(" "), cues };
}

server.registerTool(
  "connector_public_video_media",
  {
    description:
      "Local media pipeline: fetch a public video's metadata, its platform captions (with timestamps), or a limited set of evenly spaced keyframes. " +
      "Requires yt-dlp on this machine; keyframe extraction also needs ffmpeg/ffprobe. No API key needed, and nothing beyond the video itself is downloaded.",
    inputSchema: {
      type: "object",
      required: ["operation", "url"],
      properties: {
        operation: {
          type: "string",
          enum: ["collect_public_metadata", "fetch_transcript", "extract_keyframes"],
        },
        url: { type: "string", description: "Public video/playlist link (http/https)" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum playlist entries, default 1" },
        playlist: { type: "boolean", description: "Expand as a playlist, default false" },
        language: { type: "string", description: "Caption language code, default en" },
        frame_count: { type: "integer", minimum: 1, maximum: 12, description: "Number of frames to extract, default 5" },
        max_download_mb: { type: "integer", minimum: 1, maximum: 200, description: "Download size cap in MB for frame extraction, default 50" },
      },
    },
  },
  async (args) => {
    const operation = args.operation;
    const ytdlp = which("yt-dlp");
    if (!ytdlp) {
      return blockedBinary(MEDIA.connector, operation, MEDIA.provider, ["yt-dlp"],
        "pipx install yt-dlp or brew install yt-dlp");
    }
    const url = mediaUrl(args.url);

    if (operation === "collect_public_metadata") {
      const limit = Math.min(Math.max(args.limit ?? 1, 1), 50);
      const argv = [ "--dump-single-json", "--skip-download", ...YTDLP_COMMON ];
      if (args.playlist) argv.push("--flat-playlist", "--playlist-end", String(limit));
      else argv.push("--no-playlist");
      argv.push(url);
      const { stdout } = await runCommand(ytdlp, argv);
      const raw = parseJsonBuffer(stdout, MEDIA.provider);
      // Keep only public metadata fields; do not dump yt-dlp's full output (format lists, cookie-related fields)
      const pick = (v) => ({
        id: v.id ?? null, title: v.title ?? null, channel: v.channel ?? v.uploader ?? null,
        channel_id: v.channel_id ?? null, duration_seconds: v.duration ?? null,
        view_count: v.view_count ?? null, like_count: v.like_count ?? null,
        comment_count: v.comment_count ?? null, upload_date: v.upload_date ?? null,
        webpage_url: v.webpage_url ?? null,
      });
      const rows = Array.isArray(raw.entries) ? raw.entries.slice(0, limit).map(pick) : [pick(raw)];
      return envelope({
        ...MEDIA, operation, status: "completed",
        summary: `Retrieved metadata for ${rows.length} public videos.`,
        data: { rows, count: rows.length, retrieved_at: new Date().toISOString(), source_url: url },
      });
    }

    if (operation === "fetch_transcript") {
      const language = String(args.language ?? "en");
      if (!/^[A-Za-z0-9._*-]{1,32}$/.test(language)) throw new Error("params.language is invalid");
      const dir = runDir("vtt");
      try {
        await runCommand(ytdlp, [
          "--skip-download", "--write-subs", "--write-auto-subs",
          "--sub-langs", language, "--sub-format", "vtt", "--no-playlist",
          "--output", path.join(dir, "transcript.%(ext)s"), ...YTDLP_COMMON, url,
        ]).catch(() => ({}));  // yt-dlp may also exit non-zero when there are no captions; treat that as "nothing retrieved"
        const vtt = fs.readdirSync(dir).filter((f) => f.endsWith(".vtt")).sort()[0];
        if (!vtt) {
          return envelope({
            ...MEDIA, operation, status: "completed_partial",
            summary: `This video has no ${language} platform captions or auto-generated captions.`,
            data: { language_requested: language, transcript: "", cues: [] },
            limitations: [
              "The platform provides no captions in the requested language; this connector does not fall back to speech transcription.",
              "Do not write transcript content from the video title or prior knowledge.",
            ],
          });
        }
        const { transcript, cues } = parseVttCues(fs.readFileSync(path.join(dir, vtt), "utf8"));
        return envelope({
          ...MEDIA, operation, status: "completed",
          summary: `Retrieved ${cues.length} timestamped caption cues.`,
          data: {
            language_requested: language, transcript, cues,
            caption_source: "platform_caption_or_auto_caption",
            retrieved_at: new Date().toISOString(), source_url: url,
          },
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // extract_keyframes
    const ffmpeg = which("ffmpeg");
    const ffprobe = which("ffprobe");
    const missing = [!ffmpeg && "ffmpeg", !ffprobe && "ffprobe"].filter(Boolean);
    if (missing.length) {
      return blockedBinary(MEDIA.connector, operation, MEDIA.provider, missing,
        "apt install ffmpeg or brew install ffmpeg");
    }
    const frameCount = Math.min(Math.max(args.frame_count ?? 5, 1), 12);
    const maxMb = Math.min(Math.max(args.max_download_mb ?? 50, 1), 200);
    const work = runDir("media");
    const outDir = path.join(work, "frames");
    fs.mkdirSync(outDir, { recursive: true });
    try {
      await runCommand(ytdlp, [
        "--no-playlist", "--max-filesize", `${maxMb}M`,
        "--format", "worst[ext=mp4]/worst",
        "--output", path.join(work, "source.%(ext)s"), ...YTDLP_COMMON, url,
      ]);
      const files = fs.readdirSync(work)
        .map((f) => path.join(work, f))
        .filter((f) => fs.statSync(f).isFile());
      if (!files.length) throw new Error("yt-dlp produced no media file (it may have exceeded the size cap)");
      const media = files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];

      const probe = await runCommand(ffprobe, [
        "-v", "error", "-show_entries", "format=duration", "-of", "json", media,
      ]);
      const duration = Number(parseJsonBuffer(probe.stdout, "ffprobe").format?.duration);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe could not read a valid duration");

      const frames = [];
      for (let i = 1; i <= frameCount; i += 1) {
        const ts = Number(((duration * i) / (frameCount + 1)).toFixed(3));
        const target = path.join(outDir, `frame-${String(i).padStart(2, "0")}-${ts.toFixed(3)}s.jpg`);
        await runCommand(ffmpeg, [
          "-v", "error", "-ss", String(ts), "-i", media,
          "-frames:v", "1", "-q:v", "3", "-y", target,
        ], { timeoutMs: 60_000 });
        if (!fs.existsSync(target)) throw new Error(`ffmpeg produced no frame at ${ts}s`);
        frames.push({ timestamp_seconds: ts, path: target });
      }
      // Frame files stay in the temp directory for later reading; only the downloaded source video is cleaned up
      fs.rmSync(media, { force: true });
      return envelope({
        ...MEDIA, operation, status: "completed",
        summary: `Extracted ${frames.length} frames (evenly spaced across the timeline).`,
        data: {
          duration_seconds: duration, frame_count: frames.length, frames,
          selection: "evenly_spaced_bounded_v1", source_url: url,
        },
        limitations: [
          "The lowest-quality stream is downloaded to keep the size down, so frame sharpness does not represent the original.",
          `Frame files are in ${outDir}; the system cleans up the temp directory after the session ends.`,
        ],
      });
    } catch (err) {
      fs.rmSync(work, { recursive: true, force: true });
      throw err;
    }
  },
);

/* ---------- ScrapeCreators: Instagram public data ----------
 * V1 calls a pinned scrapecreators CLI (the HTTP details live in that CLI), and this does the same.
 * The key is passed via env, never in argv. Subcommand and parameter mapping match V1's
 * SCRAPECREATORS_COMMANDS verbatim. */

const SC_COMMANDS = {
  resolve_profile: ["profile", [["handle", "--handle", true]]],
  list_posts: ["user-posts", [["handle", "--handle", true], ["max_id", "--max-id", false]]],
  list_reels: ["user-reels", [["handle", "--handle", false], ["user_id", "--user-id", false], ["max_id", "--max-id", false]]],
  search_profiles: ["search-profiles", [["query", "--query", true]]],
  list_comments: ["post-comments", [["url", "--url", true], ["cursor", "--cursor", false]]],
  get_transcript: ["media-transcript", [["url", "--url", true]]],
};

server.registerTool(
  "connector_scrapecreators_instagram_public",
  {
    description:
      "ScrapeCreators Instagram public data: resolve a profile, list posts/Reels, search creators, discover trending Reels, fetch comments and transcripts. " +
      "Requires the scrapecreators CLI on this machine and a user-supplied ScrapeCreators API key (billed per credit against your own account).",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["resolve_profile", "list_posts", "list_reels", "search_profiles",
                 "discover_trending", "list_comments", "get_transcript"],
        },
        handle: { type: "string", description: "Instagram username (without @)" },
        user_id: { type: "string" },
        query: { type: "string", description: "Search term; for discover_trending, passing it uses reels-search, omitting it uses reels-trending" },
        url: { type: "string", description: "Post/Reel link" },
        max_id: { type: "string", description: "Pagination cursor" },
        cursor: { type: "string", description: "Comment pagination cursor" },
        date_posted: { type: "string", enum: ["last-hour", "last-day", "last-week", "last-month", "last-year"] },
        page: { type: "integer", minimum: 1 },
      },
    },
  },
  async (args) => {
    const operation = args.operation;
    const key = keyFor("scrapecreators");
    if (!key) return blocked("scrapecreators", operation);
    const bin = which("scrapecreators");
    if (!bin) {
      return blockedBinary("scrapecreators-connector", operation, KEYS.scrapecreators.provider,
        ["scrapecreators CLI"], "npm i -g @scrapecreators/cli");
    }

    // V1's portability audit listed this as residual risk: the provider accepts only these five
    // values, while the V1 adapter passed anything else straight through and got a failure back -
    // burning a credit for nothing. Block it up front here.
    const DATE_POSTED = ["last-hour", "last-day", "last-week", "last-month", "last-year"];
    if (args.date_posted !== undefined && !DATE_POSTED.includes(args.date_posted)) {
      throw new Error(`date_posted accepts only ${DATE_POSTED.join(" / ")}`);
    }

    let command;
    let specs;
    if (operation === "discover_trending") {
      if (args.query) {
        command = "reels-search";
        specs = [["query", "--query", true], ["date_posted", "--date-posted", false], ["page", "--page", false]];
      } else {
        command = "reels-trending";
        specs = [];
      }
    } else if (SC_COMMANDS[operation]) {
      [command, specs] = SC_COMMANDS[operation];
    } else {
      throw new Error(`unsupported Instagram operation: ${operation}`);
    }

    const argv = ["instagram", command];
    let hasIdentity = false;
    for (const [name, flag, required] of specs) {
      let value = args[name];
      if (required && (value === undefined || value === "")) {
        throw new Error(`${operation} is missing required parameter ${name}`);
      }
      if (value === undefined || value === "") continue;
      if (name === "handle" || name === "user_id") hasIdentity = true;
      if (name === "handle") value = String(value).replace(/^@+/, "");
      argv.push(flag, String(value));
    }
    if (operation === "list_reels" && !hasIdentity) {
      throw new Error("list_reels requires handle or user_id");
    }

    const { stdout } = await runCommand(bin, argv, { env: { SCRAPECREATORS_API_KEY: key } });
    const payload = parseJsonBuffer(stdout, KEYS.scrapecreators.provider);
    // CLI soft failure: HTTP 200 but a business-level failure, which must not count as success
    if (payload && (payload.error === true || payload.success === false)) {
      throw new Error(`ScrapeCreators soft failure: ${payload.code || "unknown"}`);
    }
    const credits = {
      charged: payload?.credits_charged ?? null,
      remaining: payload?.credits_remaining ?? null,
    };
    return envelope({
      connector: "scrapecreators-connector",
      operation,
      provider: KEYS.scrapecreators.provider,
      status: "completed",
      summary: `ScrapeCreators ${command} returned successfully.`,
      data: { payload, credits, retrieved_at: new Date().toISOString() },
      limitations: credits.remaining !== null
        ? [`This call consumed ${credits.charged ?? "?"} credits, ${credits.remaining} remaining.`]
        : [],
    });
  },
);

/* ---------- Gemini: video content analysis ----------
 * Ported from V1 vendor's head-video-analyzer (MIT, head-of-content/video-content-analyzer).
 * **The analysis prompt is copied verbatim** - it is the substance of this connector, and the
 * hook/structure/CTA fields it produces are consumed directly by downstream skills, so changing a
 * single word means it is no longer that validated behavior. Only the transport differs: upstream
 * uses Python's google.genai SDK, while this stays pure JS per contract §7 and calls REST directly.
 *
 * The model comes from V1's verified patch: the GEMINI_MODEL environment variable, defaulting to
 * gemini-flash-latest (upstream's original value was gemini-2.5-flash; the patch made it configurable). */

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

const VIDEO_ANALYSIS_PROMPT = (caption) => `Analyze this short-form video focusing on CONTENT STRUCTURE and HOOK TECHNIQUE.

CAPTION/TITLE CONTEXT:
${caption}

Analyze the video and return a JSON object with this exact structure:

{
    "hook": {
        "technique": "<one of: pattern-interrupt, question, bold-claim, story-tease, visual-shock, curiosity-gap, direct-address, controversial-take, relatable-pain, transformation-preview>",
        "opening_line": "<exact words or description of what's said/shown in first 3 seconds>",
        "attention_grab": "<why this hook works - be specific about the psychological trigger>",
        "replicable_formula": "<template version of this hook that could be adapted, e.g. 'If you [action], you're [consequence]'>"
    },
    "content_structure": {
        "format": "<one of: problem-solution, listicle, story, tutorial, before-after, day-in-life, reaction, transformation, hot-take, tool-demo>",
        "sections": [
            {
                "name": "<section name like 'Hook', 'Problem', 'Solution', 'CTA'>",
                "duration_pct": <percentage of video>,
                "description": "<what happens in this section>"
            }
        ],
        "pacing": "<one of: rapid-fire, fast, moderate, slow>",
        "retention_techniques": ["<list techniques used to keep viewers watching>"]
    },
    "delivery_style": {
        "speaking": "<one of: direct-to-camera, voiceover, text-only, mixed, no-speech>",
        "energy": "<one of: high-energy, conversational, calm-authority, urgent>",
        "text_overlays": <true/false>,
        "visual_style": "<description of editing style, transitions, b-roll usage>"
    },
    "cta_strategy": {
        "type": "<one of: comment-keyword, link-bio, follow, save, share, dm, none>",
        "cta_text": "<exact CTA if present>",
        "placement": "<where in video the CTA appears>"
    },
    "why_it_works": "<2-3 sentence analysis of why this content performs well>"
}

Focus on ACTIONABLE insights that could be replicated. Be specific about techniques.
Return ONLY valid JSON, no other text.`;

/** Upstream parse_response: strip the markdown fence first; if parsing fails, put the raw text into raw_analysis. */
function parseAnalysis(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  const body = fenced ? fenced[1] : text;
  try {
    return JSON.parse(body.trim());
  } catch {
    return { raw_analysis: text };
  }
}

server.registerTool(
  "connector_gemini_analyze_videos",
  {
    description:
      "Use Gemini to analyze 1-3 short videos for hook technique, content structure, delivery style, and CTA strategy, returning reusable formulas. " +
      "Requires a user-supplied Gemini API key (running against your own account and quota). Gemini fetches the videos by URL; nothing is downloaded locally.",
    inputSchema: {
      type: "object",
      required: ["videos"],
      properties: {
        videos: {
          type: "array", minItems: 1, maxItems: 3,
          description: "1-3 video objects, each with at least a video_url that resolves directly to the video stream",
          items: {
            type: "object",
            required: ["video_url"],
            properties: {
              video_url: { type: "string", description: "Direct link to the video file (note: YouTube/TikTok watch-page URLs are not direct links)" },
              caption: { type: "string", description: "Title or caption text, used as analysis context" },
              post_id: { type: "string" },
            },
          },
        },
        platform: { type: "string", enum: ["youtube", "instagram", "tiktok"], description: "Defaults to youtube" },
      },
    },
  },
  async (args) => {
    const key = keyFor("gemini");
    if (!key) return blocked("gemini", "analyze_videos");

    const videos = Array.isArray(args.videos) ? args.videos : [];
    if (videos.length < 1 || videos.length > 3) throw new Error("params.videos must be 1-3 video objects");
    const platform = args.platform ?? "youtube";
    if (!["youtube", "instagram", "tiktok"].includes(platform)) {
      throw new Error("params.platform must be youtube / instagram / tiktok");
    }

    const rows = [];
    const limitations = [];
    for (const video of videos) {
      const url = String(video?.video_url || "").trim();
      const caption = String(video?.caption || "").slice(0, 1000) || "No caption";
      const row = { post_id: video?.post_id ?? null, video_url: url, platform };
      if (!url) {
        rows.push({ ...row, error: "missing video_url" });
        continue;
      }
      try {
        // Preferred path from the upstream patch: hand the URL to Gemini as fileData so it fetches
        // the video itself, instead of embedding it as literal text in the prompt. Nothing is downloaded locally.
        const res = await fetch(
          `${GEMINI_API}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { fileData: { fileUri: url, mimeType: "video/mp4" } },
                  { text: VIDEO_ANALYSIS_PROMPT(caption) },
                ],
              }],
              generationConfig: { responseModalities: ["TEXT"] },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}`);
        const payload = await res.json();
        const text = payload?.candidates?.[0]?.content?.parts
          ?.map((part) => part?.text)
          .filter(Boolean)
          .join("") ?? "";
        if (!text) throw new Error("Gemini returned no text");
        rows.push({ ...row, analysis: parseAnalysis(text) });
      } catch (err) {
        // One failed video must not sink the whole batch - matches upstream analyze_videos' per-item tolerance
        rows.push({ ...row, error: err.message });
      }
    }

    const failed = rows.filter((r) => r.error || !r.analysis || r.analysis.raw_analysis);
    if (failed.length) {
      limitations.push(`${failed.length}/${rows.length} videos did not produce a valid analysis.`);
      limitations.push(
        "Common cause: a YouTube/TikTok watch-page URL was passed instead of a direct video link, so Gemini cannot reach the video stream. " +
        "This connector does not download videos; use connector_public_video_media to obtain a direct link first, then pass that in.",
      );
    }
    return envelope({
      connector: "gemini-connector",
      operation: "analyze_videos",
      provider: KEYS.gemini.provider,
      status: failed.length === rows.length ? "failed" : failed.length ? "completed_partial" : "completed",
      summary: `Analyzed ${rows.length - failed.length}/${rows.length} videos (model ${GEMINI_MODEL}).`,
      data: { rows, count: rows.length, failed_count: failed.length, model: GEMINI_MODEL },
      limitations,
    });
  },
);

/* ---------- health: pre-run self-check ----------
 * The required.tools gate only checks that a tool exists, while the runtime dependencies behind a
 * tool (keys, external commands) surface only at the last step of the execution chain - this tool
 * lets the main agent verify before dispatch and tell the user directly what to install. Keys are
 * reported as configured/unconfigured only, never echoed; no network access, no subprocesses. */
const HEALTH_SPEC = [
  { tool: "connector_tubelab_search_outliers", key: "tubelab", bins: [] },
  { tool: "connector_tubelab_channel_videos", key: "tubelab", bins: [] },
  {
    tool: "connector_youtube_pp",
    key: "youtube",
    bins: [{
      name: "youtube-pp-cli",
      install: "npx -y @mvanhorn/printing-press-library install youtube --cli-only (without Node, build it yourself with Go 1.26.5+)",
    }],
  },
  {
    tool: "connector_public_video_media",
    key: null,
    bins: [
      { name: "yt-dlp", install: "pipx install yt-dlp or brew install yt-dlp" },
      { name: "ffmpeg", install: "brew install ffmpeg", optional: "Needed only for extract_frames" },
      { name: "ffprobe", install: "Installed together with ffmpeg", optional: "Needed only for extract_frames" },
    ],
  },
  {
    tool: "connector_scrapecreators_instagram_public",
    key: "scrapecreators",
    bins: [{ name: "scrapecreators", install: "npm i -g @scrapecreators/cli" }],
  },
  { tool: "connector_gemini_analyze_videos", key: "gemini", bins: [] },
];

server.registerTool(
  "connector_health",
  {
    description:
      "Self-check the readiness of every connector: whether the required key is configured (status only, values are never echoed) and whether the local commands it depends on are installed (install instructions included when missing). " +
      "Call this tool before dispatching a connector-type skill to check each entry in required.tools; when a dependency is missing, tell the user how to install it instead of running the whole chain for nothing. " +
      "No inputs, no network access, no subprocesses.",
    inputSchema: { type: "object", properties: {} },
  },
  async () => {
    const tools = HEALTH_SPEC.map(({ tool, key, bins }) => {
      const keyState = key
        ? { option: KEYS[key].option, provider: KEYS[key].provider, configured: keyFor(key) !== null }
        : null;
      const binaries = bins.map((b) => ({
        name: b.name,
        found: which(b.name) !== null,
        ...(b.optional ? { optional: b.optional } : {}),
        ...(which(b.name) === null ? { install: b.install } : {}),
      }));
      const ready =
        (keyState === null || keyState.configured) &&
        binaries.every((b) => b.found || b.optional);
      return { tool, ready, key: keyState, binaries };
    });
    const notReady = tools.filter((t) => !t.ready).map((t) => t.tool);
    const limitations = [
      "Only checks that local dependencies are in place; it does not validate key validity or quota - that only shows up on a real call.",
    ];
    // In-process fetch (tubelab/gemini) honors the proxy variables only on Node >= 24 with
    // NODE_USE_ENV_PROXY=1; subprocess-based connectors get them passed through by proxyEnv() and are
    // unaffected. Reporting it here means a blocked direct fetch on a proxied network does not have
    // to wait for a failed data fetch to be diagnosed.
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (Object.keys(proxyEnv()).length > 0 && (nodeMajor < 24 || process.env.NODE_USE_ENV_PROXY !== "1")) {
      limitations.push(
        `Proxy environment variables detected, but outbound proxying is not enabled in this process (Node ${process.versions.node}; requires >= 24 and NODE_USE_ENV_PROXY=1): ` +
        "in-process fetches such as tubelab/gemini will not go through the proxy; youtube/media/scrapecreators run in subprocesses, where the proxy is passed through and unaffected.",
      );
    }
    return envelope({
      connector: "health-connector",
      operation: "check",
      provider: "Local self-check",
      status: "completed",
      summary: notReady.length === 0
        ? `All ${tools.length} connectors are ready.`
        : `${tools.length - notReady.length}/${tools.length} connectors ready; not ready: ${notReady.join(", ")} (see data for what is missing).`,
      data: { tools },
      limitations,
    });
  },
);

/* ---------- MCP stdio transport ---------- */

const PROTOCOL_VERSION = "2025-06-18";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        // Follow the version the client requested; fall back to the version this implementation supports when unknown
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "kabo-connectors", version: "0.8.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications get no response
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const handler = HANDLERS.get(params?.name);
      if (!handler) return replyError(id, -32602, `unknown tool: ${params?.name}`);
      try {
        return reply(id, await handler(params?.arguments ?? {}));
      } catch (err) {
        // An exception inside a tool must not exit the server: the entire connector surface would disappear with it
        return reply(id, {
          content: [{ type: "text", text: `internal connector error: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      return replyError(id, -32601, `unimplemented method: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // drop bad frames; they must not terminate the session
  }
  handle(msg).catch((err) => {
    replyError(msg?.id, -32603, `internal error: ${err.message}`);
  });
});

# kabo-plugins

The official **Kabo** plugin marketplace — the client for the creator-focused Skill distribution platform.

Kabo lets you search, download, and execute creator research skills inside Claude Code: YouTube public evidence collection, viral and outlier breakdowns, channel benchmarking, keyword and search intent research, multimodal video evidence collection, and cross-platform creator discovery. Every skill is signed and distributed by the platform, and the client verifies the signature locally before executing it.

## Install

In a Claude Code session:

```
/plugin marketplace add kabo-sh/kabo-plugins
/plugin install kabo-alpha@kabo-plugins
```

After installing, start a new session, pick `kabo` in `/mcp`, and complete a single browser authorization to get started. For details (third-party key configuration, local dependencies, privacy boundary), see the [plugin README](plugins/claude/kabo-alpha/README.md).

## Contents

| Plugin | Host | Description |
|---|---|---|
| [`kabo-alpha`](plugins/claude/kabo-alpha/) | Claude Code | The Kabo client: skill search/download/signature verification, restricted subagent execution, dynamic routing guidance |

> The `-alpha` suffix accurately reflects that this is currently a beta release.

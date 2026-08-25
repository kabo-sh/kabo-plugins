---
description: Show or switch this Kabo account's Production/Internal skill registry channel
---

Use the platform's registry tools only. This command changes which signed SkillPackages the same Kabo account receives; it does not sign in again and never accesses GCS directly.

1. Call `mcp__plugin_kabo-alpha_kabo__registry_channel_status` with no arguments.
2. If the user only asked what they are using, report `active_channel` and whether Internal is available, in the user's language.
3. If the user explicitly asked to switch but did not name a target, ask them to choose `internal` or `production`; do not call `mcp__plugin_kabo-alpha_kabo__registry_channel_select` until they answer.
4. Once the user names a target, call `mcp__plugin_kabo-alpha_kabo__registry_channel_select` with exactly `internal` or `production`, then report the returned `active_channel`.

Guardrails:

- Never attempt to create, remove, or bypass an Internal grant. The backend is the sole authority.
- Never edit OAuth configuration, local credentials, MCP URLs, GCS URLs, environment variables, or Plugin files as part of a channel switch.
- If Internal is unavailable, say that this Kabo account needs a server-side Internal grant; do not offer a client-side workaround.
- After a successful switch, ask the user to start a clean session before comparing Skill versions or results.

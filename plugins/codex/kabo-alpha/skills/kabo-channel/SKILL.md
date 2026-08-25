---
name: kabo-channel
description: Use explicitly when the user wants to see or change whether Kabo loads Production or Internal skills. Internal requires a server-side account grant and is the default for granted accounts.
---

# Choose the Kabo registry channel

Use the platform's registry tools only. This skill changes which signed SkillPackages the same Kabo account receives; it does not sign in again and never accesses GCS directly.

1. Call `registry_channel_status` with no arguments.
2. If the user only asked what they are using, report `active_channel` and whether Internal is available, in the user's language.
3. If the user explicitly asked to switch but did not name a target, ask them to choose `internal` or `production`; do not call `registry_channel_select` until they answer.
4. Once the user names a target, call `registry_channel_select` with exactly `internal` or `production`, then report the returned `active_channel`.

Guardrails:

- Never attempt to create, remove, or bypass an Internal grant. The backend is the sole authority.
- Never edit OAuth configuration, local credentials, MCP URLs, GCS URLs, environment variables, or Plugin files as part of a channel switch.
- If Internal is unavailable, say that this Kabo account needs a server-side Internal grant; do not offer a client-side workaround.
- After a successful switch, ask the user to start a clean session before comparing Skill versions or results.

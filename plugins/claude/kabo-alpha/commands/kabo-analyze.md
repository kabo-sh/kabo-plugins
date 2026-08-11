---
description: Kabo creator research entry point — search platform skills and run them (YouTube evidence, breakout-video breakdown, channel benchmarking, keyword research)
argument-hint: "[what to analyze, e.g. why has this channel been growing lately https://youtube.com/@xxx]"
---

The user's analysis request: $ARGUMENTS

Handle this request through the **meta-guidance** routing flow. meta-guidance is this plugin's resident skill and its content is already in the session (the dynamic version injected by SessionStart takes priority; otherwise use the static version bundled in the plugin) — follow it directly, do not invent your own approach.

Flow outline (meta-guidance is authoritative on the details; if they conflict, follow it):

1. **Search**: call `registry_skill_search`, querying by **capability keywords** (do not assume skill names).
2. **Confirm**: list the matched skills (name / description / version / permissions) for the user and **wait for them to choose** before continuing.
3. **Fetch and verify**: check the cache and revocation markers → `registry_skill_download` → `skill-unpack` → `skill-verify`. **Never execute anything that fails verification or has been revoked.**
4. **Execute**: dispatch per `execution` in `manifest.json`; `subagent` goes through skill-runner, and when `required.tools` contains `connector_*` you must also pass that section of the execution conventions from meta-guidance along to it.
5. **Deliver**: state which skill / version was used, plus the quota, truncation, and missing fields recorded in `limitations`.

## Boundaries

- When $ARGUMENTS is empty, **do not** guess what the user wants analyzed — ask for the target and the goal (channel / niche / specific video, and what conclusion they want).
- When the search finds **no** matching skill, say so plainly and describe what the catalog currently covers. **Do not** fall back to native web search or existing knowledge to invent an analysis and deliver it as Kabo output — that is the exact opposite of why this entry point exists.
- Platform tools invisible or all returning 401 → tell the user to run `/kabo-login` first.

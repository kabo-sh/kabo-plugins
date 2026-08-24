---
name: analyze
description: Kabo creator research analysis entry point. Use it when the user needs YouTube public evidence collection, channel benchmarking and playbook summaries, account-relative outlier breakdowns and the topic ideas they support, emerging-creator breakout discovery, or reverse-engineering of viral Instagram Reels; this skill only starts the flow — the actual routing and execution rules live in meta-guidance.
---

# Kabo analysis entry point

The explicit entry point when the user states a creator research need. This skill **does not implement routing itself** — read `meta-guidance` and follow it.

1. Read `../meta-guidance/SKILL.md` in the sibling directory and execute per its "Single-skill flow" or "Composite requests".
2. **Invoked with no arguments** (nothing to analyze was named): check for `<data root>/onboarding-profile.json` (data root `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex`). No profile, or a profile whose `onboarded_at` is empty (an interrupted onboarding) → hand off to `$kabo-start` (read `../kabo-start/SKILL.md` and follow it in this task) — it is the first-run path, offers Continue / Start over on an interrupted one, and discloses its own cost before anything runs. Profile complete → greet them by handle and ask what they want to look at today, using the goal and niche on file as the starting point; do not re-ask onboarding questions.
3. When the request is unclear, ask first: the analysis target (channel / niche / specific video), the conclusion they want, and the time window. **Do not guess.**
4. When the search finds no match, say plainly that it is not covered and describe which capability areas are covered today. **Do not** fall back to native web search or existing knowledge to invent an analysis and deliver it as Kabo output.
5. When all platform tools are unavailable, point the user to run `$kabo-login` first.

When delivering, follow meta-guidance Section E: the reply body is the creator-facing report the runner names on its `creator_report:` line, relayed as-is (translated to the user's language if needed). Skill/version, quota, truncation, and the `limitations` detail are run mechanics — keep them out of the reply and give them only when the user asks; what a limitation makes missing is stated in task terms inside the delivery itself.

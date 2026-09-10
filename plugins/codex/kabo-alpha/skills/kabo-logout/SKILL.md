---
name: kabo-logout
description: Use explicitly when the user asks to log out of Kabo on this machine. Drops the host's copy of the token and clears the local skill cache, run outputs, onboarding profile and trust material. It is local-only — the account's access on other devices is untouched. Account-wide revocation is a different skill, $kabo-revoke.
---

# Log out of Kabo (this machine)

Logging out here is **two** actions, and both are local:

1. **Drop the host's token** — `codex mcp logout kabo`.
2. **Clear this machine** — the local skill cache, run outputs and trust material.

Neither touches the platform. There is no Kabo credential file on this machine either: the host holds the token, and dropping it is what ends this machine's access.

**This machine only, and that is the whole design.** The account's authorization on other devices, in other MCP clients and in the desktop app is left exactly as it was. Nothing here goes over the network, so a logout can never fail on a bad connection and is complete the second the commands return.

**Do not** call Kabo's `auth_revoke_all` tool here. That revokes the account's grants on *every* device — a different request, with its own skill, `$kabo-revoke`. Route the user there if what they want is "sign me out everywhere" or "I lost a machine"; never widen a logout into a revocation on your own.

## 1. Drop the host's token

```
codex mcp logout kabo
```

This is the same-second cutoff: the host stops holding a token for Kabo, so the next call has nothing to present. Run it first — everything after it is cleanup.

## 2. Clear the local cache

Resolve the plugin root two levels up from this `SKILL.md` path, then run:

```
<plugin-root>/bin/kabo-auth logout
```

Report what it cleared: the Codex skill cache (including revocation markers), the **run work directories** under `<data root>/work/`, the **onboarding profile** `<data root>/onboarding-profile.json` (the questionnaire answers, diagnosis, baseline and 90-day plan from `$kabo-start` — no secrets, but the account's own diagnosis, so it goes with the work directories; the next sign-in starts onboarding over), the pinned server public keyset, the meta-guidance cache, and the verification failure events still awaiting relay.

Name the work directories explicitly rather than folding them into "the cache". A cache being cleared costs a refetch; the work directories hold the assembled snapshots, analyses and rendered reports of every past run on this machine, and they are gone. A user who is only told "cache cleared" learns about that loss later, from an empty directory.

## 3. Tell the user what is now true

- **This machine is cut off the same second.** The host no longer holds a token for Kabo.
- **Everywhere else is unchanged.** Other devices and MCP clients keep working and keep renewing — this command reached none of them. If the user wanted "everywhere", that is `$kabo-revoke`.
- **The account's grant still exists.** Signing back in here does not need a fresh consent to be *created*, just approved: `$kabo-login` walks them through it.

Do not search for, read, or mention any local token or credentials file at any point; they do not exist.

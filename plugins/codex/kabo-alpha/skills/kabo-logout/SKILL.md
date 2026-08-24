---
name: kabo-logout
description: Use explicitly when the user asks to log out of Kabo or revoke its access. Revokes every OAuth grant the account has issued to Kabo through the platform's auth_revoke_all tool, then clears the local skill cache, run outputs, onboarding profile and trust material. There is no credentials file on this machine to delete.
---

# Log out of Kabo

Logging out is **two** actions, and only doing both is a logout:

1. **Revoke on the platform** — over the MCP connection that is already authorized.
2. **Clear this machine** — the local skill cache and trust material.

Neither step touches a token. There is no Kabo token on this machine: the host holds it, the platform revokes its own grants, and this skill orchestrates the two.

## 1. Revoke the authorization (do this first)

Call Kabo's `auth_revoke_all` tool with no arguments.

This is the one thing that actually logs the user out. It destroys **every** OAuth grant the account has issued to Kabo — refresh tokens and stored consents, on every device and in every MCP client, not just this session. It rides the already-connected MCP link, so it needs nothing from this machine.

**If the Kabo tools are invisible or the call returns 401**: this session was never authorized, so there is nothing to revoke. Say exactly that — it is not a failure — and go straight to step 2.

**Do not** try any other revocation route if the call errors: no HTTP request assembled in the shell, no hunt for a local token. Report the error and offer the disconnect from step 3, which is effective on its own.

## 2. Clear the local cache

Resolve the plugin root two levels up from this `SKILL.md` path, then run:

```
<plugin-root>/bin/kabo-auth logout
```

Report what it cleared: the Codex skill cache (including revocation markers), the **run work directories** under `<data root>/work/`, the **onboarding profile** `<data root>/onboarding-profile.json` (the questionnaire answers, diagnosis, baseline and 90-day plan from `$kabo-start` — no secrets, but the account's own diagnosis, so it goes with the work directories; the next sign-in starts onboarding over), the pinned server public keyset, the meta-guidance cache, and the verification failure events still awaiting relay. There is no credentials file on this machine — it was removed wholesale in 0.9.0.

Name the work directories explicitly rather than folding them into "the cache". A cache being cleared costs a refetch; the work directories hold the assembled snapshots, analyses and rendered reports of every past run on this machine, and they are gone. A user who is only told "cache cleared" learns about that loss later, from an empty directory.

## 3. Tell the user what is now true

Report the counts `auth_revoke_all` returned, then these three facts. The second one is what users get wrong, so do not bury it:

- **It applies to every device.** All of the account's Kabo authorizations are gone, not just this session's. Anywhere else Kabo was authorized, the next renewal fails.
- **It is not instant.** The access token the host already holds is a self-contained JWT and the platform runs no denylist, so this connection can keep working for up to **2 more hours (120 minutes)**. Nothing can be renewed after that.
- **To cut it off right now**: run `codex mcp logout kabo`. That drops the host's copy of the token immediately, and it is the only same-second cutoff available.

Signing back in later means a fresh browser consent — `$kabo-login` walks them through it.

Do not search for, read, or mention any local token or credentials file at any point; they do not exist.

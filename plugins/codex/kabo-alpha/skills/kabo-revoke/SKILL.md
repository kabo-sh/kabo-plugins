---
name: kabo-revoke
description: Use explicitly when the user asks to revoke Kabo's access account-wide — sign out everywhere, or after losing a machine. Revokes every OAuth grant the account has issued to Kabo through the platform's auth_revoke_all tool, then logs this machine out too. Plain "log me out" is the local-only skill, $kabo-logout.
---

# Revoke Kabo everywhere

Revoke the account's Kabo authorization **on every device**, then log this machine out too. This is the account-wide command; the everyday one is `$kabo-logout`, which is local-only.

Only run this when the user has actually asked for the account-wide effect — "sign me out everywhere", "I lost my laptop", "revoke Kabo's access". If they only said "log out", use `$kabo-logout` instead and say why.

**Say what it does before you do it**, in one line, and wait for a yes: it destroys every OAuth grant the account has issued to Kabo — refresh tokens and stored consents, on every device and in every MCP client, including the desktop app and any other machine the user is signed in on. Each of those needs a fresh sign-in afterwards.

## 1. Revoke on the platform (do this first)

Call Kabo's `auth_revoke_all` tool with no arguments. It rides the already-connected MCP link, so it needs nothing from this machine. Do it before anything below: step 3 removes the token this call is riding on.

**If the Kabo tools are invisible or the call returns 401**: this session was never authorized, so there is nothing to revoke *from here*. Say exactly that — it is not a failure — and note that other devices are therefore untouched: revocation needs an authorized connection, and the user can run this from a machine that still has one, or sign in here first with `$kabo-login`. Then continue with steps 2 and 3, which are effective on their own for this machine.

**Do not** try any other revocation route if the call errors: no HTTP request assembled in the shell, no hunt for a local token. Report the error and continue.

## 2. Clear the local cache

Resolve the plugin root two levels up from this `SKILL.md` path, then run:

```
<plugin-root>/bin/kabo-auth logout
```

It clears the same local data `$kabo-logout` reports — including the **run work directories** under `<data root>/work/` (every past run's assembled snapshots, analyses and rendered reports on this machine) and the **onboarding profile** `<data root>/onboarding-profile.json`. Name those two separately rather than folding them into "the cache": a cleared cache costs a refetch, that is output the user may have wanted to keep.

## 3. Drop the host's token

```
codex mcp logout kabo
```

This is the only same-second cutoff for this machine — the platform runs no denylist, so without it the token the host already holds keeps working until it expires.

## 4. Tell the user what is now true

Report the counts `auth_revoke_all` returned, then these facts. The middle one is what users get wrong, so do not bury it:

- **It applies to every device.** All of the account's Kabo authorizations are gone, not just this session's. Anywhere else Kabo was authorized, the next renewal fails.
- **It is not instant elsewhere.** An access token another machine already holds is a self-contained JWT and the platform runs no denylist, so that machine can keep working for up to **2 more hours (120 minutes)**. Nothing can be renewed after that.
- **This machine is cut off the same second**, because step 3 dropped the host's copy of the token.

Signing back in — on every device that needs it — means a fresh browser consent each time; `$kabo-login` walks them through it.

Do not search for, read, or mention any local token or credentials file at any point; they do not exist.

---
description: Revoke Kabo's authorization on every device — for a lost or stolen machine; also logs this machine out
---

Revoke the account's Kabo authorization **everywhere**, then log this machine out too. This is the account-wide command; the everyday one is `/kabo-logout`, which is local-only.

Only run this when the user has actually asked for the account-wide effect — "sign me out everywhere", "I lost my laptop", "revoke Kabo's access". If they only said "log out", use `/kabo-logout` instead and say why.

**Say what it does before you do it**, in one line, and wait for a yes: it destroys every OAuth grant the account has issued to Kabo — refresh tokens and stored consents, on every device and in every MCP client, including the desktop app and any other machine the user is signed in on. Each of those needs a fresh `/kabo-login` afterwards.

**The order cannot be swapped.** Step 1 needs a working connection, and the connection needs the credential that step 2 deletes. Delete first and the revocation becomes impossible from here.

## 1. Revoke on the platform (do this first)

Call `mcp__plugin_kabo-alpha_kabo__auth_revoke_all` with no arguments. It rides the already-authorized connection, so it needs nothing from you.

**If the Kabo tools are invisible or the call returns 401**: this machine is not authorized, so there is nothing to revoke *from here*. Say exactly that — it is not a failure — and note that other devices are therefore untouched: revocation needs an authorized connection, and the user can run this command from a machine that still has one, or sign in here first with `/kabo-login`. Then go to step 2, which still cleans up anything left on disk.

**Do not** try any other revocation route if the call errors: no HTTP request assembled in Bash, no hunt for a local token. Report the error and run step 2 anyway — on this machine that is already a complete cutoff.

## 2. Log this machine out

```
kabo-auth logout
```

(`bin/` is already on PATH; `${CLAUDE_PLUGIN_ROOT}/bin/kabo-auth` also works.) It deletes this machine's credential and local data — the same list `/kabo-logout` reports, including `~/.kabo/work/` (**every past run's outputs on this machine**) and `~/.kabo/onboarding-profile.json`. Report those two separately rather than folding them into "the cache": a cleared cache costs a refetch, that is output the user may have wanted to keep.

## 3. Tell the user what is now true

Report the counts `auth_revoke_all` returned, then be exact about *when* each surface actually stops working. Do not compress this into one sentence — the middle two rows are what users get wrong:

| Surface | Cut off | Why |
|---|---|---|
| This machine's next call | **the same second** | the credential file is gone, so the plugin emits no header and the request 401s |
| A call already in flight here | when it finishes | nothing interrupts a request already on the wire |
| An access token cached **on another machine** | **up to 2 hours (120 minutes)** | it is a self-contained JWT and the platform runs no denylist |
| Renewal, anywhere | **the same second** | the refresh token is revoked, so every renewal fails immediately |

So: *this* machine is cut off instantly, and any other machine keeps working for at most 2 hours before it can no longer renew.

Signing back in — on every device that needs it — takes one command each: `/kabo-login`.

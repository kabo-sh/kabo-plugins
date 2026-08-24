---
description: Revoke Kabo's platform authorization on every device, then delete this machine's credential and caches
---

Log the user out of Kabo properly. That is **two** actions, and only doing both is a logout:

1. **Revoke on the platform** — over the MCP connection that is currently authorized.
2. **Delete this machine's credential** — plus the local skill cache and trust material.

**The order cannot be swapped.** Step 1 needs a working connection, and the connection needs the credential that step 2 deletes. Delete first and the revocation becomes impossible from here.

## 1. Revoke the authorization (do this first)

Call `mcp__plugin_kabo-alpha_kabo__auth_revoke_all` with no arguments.

It destroys **every** OAuth grant the account has issued to Kabo — refresh tokens and stored consents, on every device and in every MCP client, not just this session. It rides the already-authorized connection, so it needs nothing from you.

**If the Kabo tools are invisible or the call returns 401**: this machine is not authorized, so there is nothing to revoke. Say exactly that — it is not a failure — and go straight to step 2, which still cleans up anything left on disk.

**Do not** try any other revocation route if the call errors: no HTTP request assembled in Bash, no hunt for a local token. Report the error and run step 2 anyway — on this machine that is already a complete cutoff.

## 2. Delete the local credential and caches

Run the bundled script with Bash (`bin/` is already on PATH; the absolute path `${CLAUDE_PLUGIN_ROOT}/bin/kabo-auth` also works):

```
kabo-auth logout
```

Report what it deleted:
- `~/.kabo/credentials.json`: **the sign-in credential itself** — after this, this machine cannot call Kabo at all
- `~/.kabo/credentials.lock`: the renewal lock, if one was left behind
- `~/.kabo/skill-cache/`: downloaded and unpacked skills plus revocation markers
- `~/.kabo/work/`: **the run work directories** — every past run's assembled snapshots, analyses and rendered reports on this machine. Name them separately rather than folding them into "the cache": a cleared cache costs a refetch, while this is output the user may have wanted to keep, and hearing about it later from an empty directory is worse than hearing it now
- `~/.kabo/onboarding-profile.json`: **the onboarding profile** — the questionnaire answers, diagnosis, baseline and 90-day plan from `/kabo-start`. No secrets in it, but it is the account's own diagnosis, so it goes with the work directories; the next sign-in starts onboarding over
- the pinned server signing keyset (fetched again next time)
- the signature-verified meta-guidance cache
- the buffered skill-verification failure records still awaiting relay

## 3. Tell the user what is now true

Report the counts `auth_revoke_all` returned, then be exact about *when* each surface actually stops working. Do not compress this into one sentence — the middle two rows are what users get wrong:

| Surface | Cut off | Why |
|---|---|---|
| This machine's next call | **the same second** | the credential file is gone, so the plugin emits no header and the request 401s |
| A call already in flight here | when it finishes | nothing interrupts a request already on the wire |
| An access token cached **on another machine** | **up to 2 hours (120 minutes)** | it is a self-contained JWT and the platform runs no denylist |
| Renewal, anywhere | **the same second** | the refresh token is revoked, so every renewal fails immediately |

So: revocation plus step 2 means *this* machine is cut off instantly, and any other machine keeps working for at most 2 hours before it can no longer renew.

Signing back in later takes one command — `/kabo-login` walks them through it.

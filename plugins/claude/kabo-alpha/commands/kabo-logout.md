---
description: Log out of Kabo on this machine — delete this machine's credential and local caches; other devices keep their access
---

Log the user out of Kabo **on this machine**. One action, entirely local:

Run the bundled script with Bash (`bin/` is already on PATH; the absolute path `${CLAUDE_PLUGIN_ROOT}/bin/kabo-auth` also works):

```
kabo-auth logout
```

**This machine only, and that is the whole design.** It deletes what this machine holds and touches nothing else: the account's authorization on other machines, in other MCP clients, and in the desktop app is left exactly as it was. Nothing here goes over the network, so a logout can never fail on a bad connection, never hangs, and is complete the second the command returns.

**Do not** call `mcp__plugin_kabo-alpha_kabo__auth_revoke_all` here. That tool revokes the account's grants on *every* device, which is a different request with a different command — `/kabo-revoke`. Route the user there if what they actually want is "sign me out everywhere" or "I lost a machine"; never widen a logout into a revocation on your own.

## What it deleted

Report the paths:
- `~/.kabo/credentials.json`: **the sign-in credential itself** — after this, this machine cannot call Kabo at all
- `~/.kabo/credentials.lock`: the renewal lock, if one was left behind
- `~/.kabo/skill-cache/`: downloaded and unpacked skills plus revocation markers
- `~/.kabo/work/`: **the run work directories** — every past run's assembled snapshots, analyses and rendered reports on this machine. Name them separately rather than folding them into "the cache": a cleared cache costs a refetch, while this is output the user may have wanted to keep, and hearing about it later from an empty directory is worse than hearing it now
- `~/.kabo/onboarding-profile.json`: **the onboarding profile** — the questionnaire answers, diagnosis, baseline and 90-day plan from `/kabo-start`. No secrets in it, but it is the account's own diagnosis, so it goes with the work directories; the next sign-in starts onboarding over
- the pinned server signing keyset (fetched again next time)
- the signature-verified meta-guidance cache
- the buffered skill-verification failure records still awaiting relay

If the script reports it could not remove `credentials.json`, say so plainly and do not call the logout done: the file still being there means this machine is still signed in.

## Tell the user what is now true

Two facts, and the second is the one users get wrong — do not drop it:

| Surface | State after this command |
|---|---|
| This machine's next call | **cut off the same second** — the credential file is gone, so the plugin emits no header and the request 401s |
| Every other device, MCP client, and the desktop app | **unchanged** — they keep working and keep renewing, exactly as before |

A call already in flight from this machine finishes; nothing interrupts a request already on the wire.

If the user wanted "everywhere", that is `/kabo-revoke`. Signing back in here later takes one command — `/kabo-login` walks them through it.

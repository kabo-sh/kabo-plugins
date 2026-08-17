---
description: Sign in to Kabo from the terminal (a short code, confirmed in a browser tab on any device)
---

Get the user authorized. One step: run the bundled script, have them confirm the code it prints.

**Make this clear first**: sign-in happens in the terminal, and the browser tab only confirms a code. The plugin then holds a renewable credential in a `0600` file under `~/.kabo`, and reads it for you on every request. **You never touch it** — do not open it, print it, cat it, or assemble an Authorization header from anything; that is the plugin's job and doing it by hand is both a leak and a bug.

Requires **Claude Code 2.1.195 or newer** — see the troubleshooting section, this is the first thing to check when sign-in succeeded but the tools stay invisible.

## 1. Sign in

Use Bash to run the bundled script (`bin/` is already on PATH; `${CLAUDE_PLUGIN_ROOT}/bin/kabo-auth` also works):

```
kabo-auth login
```

It prints a URL and an 8-character code, opens the URL in a browser when it can, and then waits. Read the code back to the user and tell them two things:

- the page can be opened **on any device** — their phone works, and so does another machine; nothing has to open on this box;
- the page shows a code too, and it must **match** the one in the terminal. That comparison is the only thing standing between them and approving somebody else's sign-in request, so never tell them to skip it.

The command waits up to 15 minutes and exits 0 the moment they confirm. Ctrl-C cancels and stores nothing.

If no browser appeared (headless, SSH, container, or no opener installed), that is **not an error**: the printed URL is the whole fallback and the flow was designed around it. This is also why the old browser-launch failure ([anthropics/claude-code#36307](https://github.com/anthropics/claude-code/issues/36307), merged into #11585) no longer blocks anyone — a terminal that cannot open a browser can still complete this.

Exit codes are worth reading back accurately: `1` means declined, expired, or a deployment that does not offer terminal sign-in (the message says which); `2` means the network could not be reached, so retrying is the fix, not signing in differently.

## 2. Activate in this session — no restart needed

Sign-in takes effect in the running session; never tell the user to restart as the first move. On success, tell them explicitly: **run `/mcp reconnect kabo` to activate the Kabo tools in this session — no restart needed** (Claude Code 2.1.205 or newer; `/reload-plugins` also works). Reconnecting re-runs the plugin's credential helper, which now finds the fresh credential. You cannot run that slash command for them — it is theirs to type. On a Claude Code older than 2.1.205, `/reload-plugins` is the way in — a new session is only the last resort if the tools still do not appear.

If the Kabo tools were already visible (just failing with 401), you may not even need the reconnect: the host re-runs the credential helper and retries once when a tool call answers 401/403, so go straight to the verification call below and only fall back to the reconnect if it still fails.

## 3. Verify with a real call

Confirm instead of claiming success: call `mcp__plugin_kabo-alpha_kabo__registry_skill_search` with query `youtube`.

- Results returned → tell the user they are authorized, name a couple of the skills that came back, and mention they can state a request directly or use `/kabo-analyze`.
- Tools still invisible or 401 → the sign-in worked but the connection did not pick it up; have the user run `/mcp reconnect kabo`, then retry the call. Still stuck → troubleshooting.

`kabo-auth status` reports whether this machine is signed in, to which deployment, and how long that is good for. It never prints a token.

## Troubleshooting: signed in, but the tools are still not there

1. **Host version.** The plugin points the `kabo` server at a helper via `${CLAUDE_PLUGIN_ROOT}`, and that substitution only works on **Claude Code 2.1.195 or newer**. On an older host the path is taken literally, the helper never runs, and every request 401s. The host's own OAuth fallback may then offer to authorize — do not send the user through it: it leaves a host-held token this plugin's sign-in, logout, and telemetry model does not manage. Have the user upgrade Claude Code; that is the only supported fix.
2. **Stale connection.** A session that started before sign-in may still hold the failed server. `/mcp reconnect kabo` (Claude Code 2.1.205 or newer) or `/reload-plugins` re-runs the credential helper on the spot; hosts older than 2.1.205 use `/reload-plugins` alone, and a new session is only the last resort.
3. **Wrong deployment.** If `KABO_API_ENDPOINT` was set to something other than the deployment they signed in to, the credential is deliberately refused. `kabo-auth status` says so explicitly; re-run `kabo-auth login` against the configured one.
4. Still stuck → offer the connector path below. Do **not** start hunting for a token.

### Fallback outside Claude Code

Anyone with a Claude account can reach Kabo's data plane without this plugin: in **claude.ai** or the Claude chat desktop app, go to **Settings → Connectors**, add a custom connector with the URL `https://kabo.sh/mcp`, and authorize it there.

Say plainly what they lose: that surface is **data only**. The platform tools answer, but the skill orchestration this plugin provides — meta-guidance routing, signed skill download, local signature verification, the restricted skill-runner subagent — does not exist there. Offer it as a fallback, never as the recommended path, and never as a substitute for signing in here (adding the same server as a connector *in Claude Code* changes the registered tool prefixes and breaks skill-runner).

## Hard rules

- **Do not** read, print, copy, or edit the local credential file, and do not go looking for one anywhere else. The plugin's helper is the only thing that reads it.
- **Do not** use Bash to assemble an Authorization header and call the platform HTTP API directly to "bypass" a failure. It leaks the token into your context, the shell history, and the process list — and the failure it is meant to route around is always something else.
- **Do not** ask the user to enter, paste, or store a token anywhere. There is nothing for them to type: the only thing they ever handle is the 8-character code, and that is not a token.
- If the user asks how to **revoke** authorization: run `/kabo-logout`. It revokes every device through the platform and then deletes this machine's credential.

## There are no provider keys to configure (bring up only when needed)

As of 0.12.0 every creator research fetch runs **on Kabo's servers**: the platform holds the provider credentials and the user configures nothing. This plugin declares no config fields at all, and `kabo` is the only server in its `.mcp.json`.

If a fetch comes back `blocked_setup` (the platform is missing that credential) or `unsupported` (that operation is not implemented server-side yet), it is a **platform-side gap the user cannot fix** — say so plainly, and never send them off to configure a key or paste one into the conversation. `data_connector_catalog` reports the state of every connector and operation without fetching anything.

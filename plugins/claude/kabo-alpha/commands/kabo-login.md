---
description: Sign in to Kabo from the terminal (a short code, confirmed in a browser tab on any device)
---

Get the user authorized: run the bundled script's two-step sign-in, have them confirm the code it prints, then collect the approval.

**Make this clear first**: sign-in happens in the terminal, and the browser tab only confirms a code. The plugin then holds a renewable credential in a `0600` file under `~/.kabo`, and reads it for you on every request. **You never touch it** — do not open it, print it, cat it, or assemble an Authorization header from anything; that is the plugin's job and doing it by hand is both a leak and a bug.

Requires **Claude Code 2.1.195 or newer** — see the troubleshooting section, this is the first thing to check when sign-in succeeded but the tools stay invisible.

## 1. Sign in — start, then wait

The sign-in is two commands on purpose: the start step returns immediately, and the wait step can be killed and re-run without losing anything — which is exactly what happens when a Bash tool timeout cuts it off. Use Bash to run the bundled script (`bin/` is already on PATH; `${CLAUDE_PLUGIN_ROOT}/bin/kabo-auth` also works):

```
kabo-auth login --start
```

It prints a URL and an 8-character code, records the pending sign-in on disk, and exits at once. Read the code back to the user and tell them two things:

- the page can be opened **on any device** — their phone works, and so does another machine; nothing has to open on this box;
- the page shows a code too, and it must **match** the one in the terminal. That comparison is the only thing standing between them and approving somebody else's sign-in request, so never tell them to skip it.

Then collect the approval — set the Bash tool timeout as high as it goes (600000 ms):

```
kabo-auth login --wait
```

It waits and exits 0 the moment they confirm; the code stays valid for 15 minutes. **If the tool timeout kills `--wait`, run `kabo-auth login --wait` again.** That resumption is designed in, not a workaround: the pending sign-in survives on disk, and the next `--wait` picks up the same code — it is **not** a new sign-in, so never restart with `--start` and never tell the user their approval was lost. Re-running `--start` while a sign-in is pending is harmless anyway: it re-prints the same code rather than voiding it with a new one.

If no browser appeared (headless, SSH, container, or no opener installed), that is **not an error**: the printed URL is the whole fallback and the flow was designed around it. This is also why the old browser-launch failure ([anthropics/claude-code#36307](https://github.com/anthropics/claude-code/issues/36307), merged into #11585) no longer blocks anyone — a terminal that cannot open a browser can still complete this.

Exit codes are worth reading back accurately: `1` means declined, expired, no sign-in in progress, or a deployment that does not offer terminal sign-in (the message says which); `2` means the network could not be reached — the pending sign-in is kept, so the fix is to run `kabo-auth login --wait` again, not to sign in differently.

(Plain `kabo-auth login` with no flag still runs both halves in one blocking process. It is for a human driving a terminal directly; from the Bash tool always use the split form, because the blocking form is what tool timeouts kill mid-wait.)

## 2. Verify with a real call — before any activation advice

Sign-in takes effect in the running session on its own more often than not: the host re-runs the plugin's credential helper on every connection and once more, with a retry, when a tool call answers 401/403. So the first move after `--wait` exits 0 is **not** to tell the user to do anything — it is to confirm instead of claiming success: call `mcp__plugin_kabo-alpha_kabo__registry_skill_search` with query `youtube`.

- Results returned → the user is authorized. **Do not recite the skill list** — what happens next depends on whether this machine has a creator profile:
  - `~/.kabo/onboarding-profile.json` **does not exist** → this is a first sign-in. Go directly into the onboarding flow defined in `commands/kabo-start.md`: open with its welcome line and start its questionnaire. The onboarding is the authorized-confirmation message.
  - The profile **exists but `onboarded_at` is empty** → an interrupted onboarding. Hand off to `commands/kabo-start.md`, which offers to continue where they stopped (it never re-runs a finished analysis).
  - The profile **is complete** → welcome them back by handle, remind them of their plan (goal and cadence from the profile), and offer the next step from it. They can also state a request directly or use `/kabo-analyze`.
- Tool invisible, or the call answers 401 → the sign-in worked but this session has not picked it up. Only now give the activation guidance in section 3, then retry the call once they have done it. Still stuck → troubleshooting.

## 3. Only if Kabo is still unavailable: activate

Say it in this order, host-agnostic first:

1. **"If Kabo is still unavailable in this session, start a new session."** That works on every host — terminal, IDE extension, and the desktop app (Cmd/Ctrl+N there) — and a new session re-runs the credential helper with the fresh credential. This is the whole advice for a desktop or IDE user; never route them to the host's own "Authenticate"/OAuth prompt for `kabo` (the plugin is the auth path, and the host's OAuth leaves a token the plugin cannot manage).
2. **CLI only, as an optional accelerator**: in a Claude Code CLI session that is already open, `/mcp reconnect plugin:kabo-alpha:kabo` (Claude Code CLI 2.1.205 or newer; `/reload-plugins` on an older CLI) reconnects without a restart. The reconnect must use that full registered name: the host registers the bundled server as `plugin:kabo-alpha:kabo`, and a reconnect naming only `kabo` is answered with "There's no MCP server named ..." and activates nothing. If the **full** name draws that same answer, the session predates the plugin itself, not just the sign-in — the server was never registered in it, so there is nothing to reconnect; `/reload-plugins` loads a just-installed or just-enabled plugin in place on the CLI, and a new session loads it everywhere. Do not keep re-issuing the reconnect against that answer. And if the reconnect is answered with **"Reconnect, enable, and disable aren't available in this session."**, the session is a desktop-app (or other thin-client) one — the argument form is refused there even though the engine supports it (field-tested on the desktop app, 2026-08-24). A new session is the only activation path; do not retry the command or hunt for an alternative slash command. You cannot run slash commands for them — they are the user's to type.

**Which host am I on?** Nothing in the session tells you reliably, so do not guess from the terminal. One hint: the host exports `CLAUDE_CODE_ENTRYPOINT` (undocumented — read it with Bash, `printenv CLAUDE_CODE_ENTRYPOINT`): `claude-desktop` / `claude-desktop-3p` mean the desktop app, `claude-vscode` the IDE extension, `cli` or unset a terminal. Use it only to decide whether the CLI accelerator in step 2 is worth mentioning. When it is unset or unfamiliar, either ask the user which app they are in or stay with the host-agnostic sentence — "start a new session" is never wrong.

`kabo-auth status` reports whether this machine is signed in, to which deployment, and how long that is good for. It never prints a token.

## Troubleshooting: signed in, but the tools are still not there

1. **Run `kabo-auth status` first.** It is the one step that tells the failure modes apart instead of guessing. `Signed in to X, but this session is configured for Y` means the credential and `KABO_API_ENDPOINT` disagree — the credential is deliberately refused, so fix the endpoint (or sign in to the configured deployment with `/kabo-login`); repeating the sign-in without looking here just mints another credential that mismatches the same way. `Not signed in on this machine` means the sign-in never landed — run `/kabo-login`. Signed in to the right deployment → keep going down this list.
2. **Host version.** The plugin points the `kabo` server at a helper via `${CLAUDE_PLUGIN_ROOT}`, and that substitution only works on **Claude Code 2.1.195 or newer**. On an older host the path is taken literally, the helper never runs, and every request 401s. The host's own OAuth fallback may then offer to authorize — do not send the user through it: it leaves a host-held token this plugin's sign-in, logout, and telemetry model does not manage. Have the user upgrade Claude Code; that is the only supported fix.
3. **Stale connection.** A session that started before sign-in may still hold the failed server. Host-agnostic fix first: start a new session — it re-runs the credential helper on every host, the desktop app included. In a Claude Code CLI session that is already open, `/mcp reconnect plugin:kabo-alpha:kabo` (CLI 2.1.205 or newer) or `/reload-plugins` (older CLI) does the same on the spot — use the full registered name, because a reconnect naming only `kabo` is answered with "There's no MCP server named ...". When the full name draws that same answer, the session predates the plugin itself (just installed or just enabled) and there is no server to reconnect — `/reload-plugins` loads it in place on the CLI, a new session loads it everywhere; repeating the reconnect cannot succeed. Once the host has already marked `kabo` as needing authentication (its 401 retry failed too), a new session is the only honest advice on any host — not the host's Authenticate button.
4. **A pre-plugin registration is shadowing the bundled server.** A machine that once followed the pre-plugin guidance (`claude mcp add kabo …`) still carries that direct registration: the same endpoint under its own name, tools prefixed `mcp__kabo__*` (which skill-runner's allowlist rejects), and a host-held OAuth token that `/kabo-logout` cannot revoke. None of that is permanent — remove it with `claude mcp logout kabo && claude mcp remove kabo` in a terminal (regular `claude` commands, not slash commands), then start a new session; re-running the install script detects it and offers the same removal. A custom connector added in claude.ai's **Settings → Connectors** lives in the account, not on this machine — it is removed on that same settings page, and no CLI command touches it.
5. Still stuck → offer the connector path below. Do **not** start hunting for a token.

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

---
name: kabo-login
description: Connect and authorize the Kabo platform. Open the sign-in page in a browser, complete the host's OAuth authorization, and verify it with one real call; no token is stored on this machine, and no credentials file is read or written.
---

# Connect to Kabo

Get the user authorized. Two steps: warm up the web session in a browser, then approve the MCP connection.

**Make this clear first**: there is no "terminal login" for Kabo. No Kabo token is stored on this machine, there is no credentials file, and there is nowhere to enter a token. Authorization happens only in the MCP connection layer; the **host** holds the token and refreshes it. The script in step 1 opens a web page and nothing else — it never receives or stores anything.

## 1. Open the sign-in page

Resolve the plugin root two levels up from this `SKILL.md` path, then run:

```
<plugin-root>/bin/kabo-auth login
```

A browser opens on Kabo's sign-in page, and the URL is printed as well. Have the user sign in there.

Why this comes first: it establishes the **web** session up front, so the consent screen in step 2 is a single click instead of a full sign-in — which is exactly where the flow tends to stall.

If no browser appeared (headless, SSH, or no opener installed), the printed URL is the whole fallback: have the user open it in any browser. Do not treat that as an error.

## 2. Authorize the connection

```
codex mcp login kabo --scopes openid,offline_access,account:read,registry,telemetry,data
```

A browser completes the OAuth authorization (OAuth 2.1 + PKCE on the platform side). `kabo` is the server name declared in this plugin's `.mcp.json`. Because they signed in at step 1, this should be a single consent click.

**The `--scopes` list is required, exactly as written.** Codex's own default scope request includes `email`, which Kabo's authorization server does not offer: it rejects the client registration with `invalid_scope` before any consent page appears, so a bare `codex mcp login kabo` dies with what reads like a sign-in failure but is only this scope mismatch. Do not "fix" it by trimming the list down (say, to `openid,profile`) either — a short list still produces a consent page and a green CLI message, then fails silently later: without `offline_access` the server issues no renewal token and the user is kicked out after ~2 hours with no visible error, and without `registry`/`telemetry`/`data` the platform tools 403. The list above is the contract scope set, byte-identical to the `OAUTH_SCOPE` the Claude variant requests.

Once authorization completes, the **host** holds the token — but a task's tool list is negotiated once, when the task starts. A task that was already running when authorization finished (this one, usually) will never see the Kabo tools, and that is not an authorization failure; step 3 says what to do about it.

**If the browser never opens**: the CLI still prints the authorization URL — have the user copy it into a browser and finish the flow there; the callback returns to the waiting CLI. The Claude Code build hits the same failure as a known host bug (anthropics/claude-code#36307) and the manual-URL workaround is identical. It is not a Kabo failure and there is nothing on the platform side to fix.

**Fallback outside Codex**: anyone with a Claude account can add `https://kabo.sh/mcp` as a custom connector in claude.ai or the Claude chat desktop app (**Settings → Connectors**) and authorize it there. Say plainly what it costs — that surface is **data only**: the platform tools answer, but skill routing, signed download, signature verification, and isolated execution do not exist on it. Offer it as a fallback, never as the recommended path.

## 3. Verify with a real call

Confirm instead of claiming success: call Kabo's `registry_skill_search` with query `youtube`.

- Results returned → the user is authorized. **Do not recite the skill list** — what happens next depends on whether this machine has an onboarding profile at `<data root>/onboarding-profile.json` (data root `$KABO_CODEX_DATA`, falling back to `~/.kabo/codex`; never `~/.kabo/` itself, which is the Claude variant's root):
  - The profile **does not exist** → this is a first sign-in. Go directly into `$kabo-start` (read `../kabo-start/SKILL.md` in the sibling directory and follow it in this task): open with its welcome line and start its questionnaire. The onboarding is the authorized-confirmation message. Its cost — real analysis time and a meaningful share of the user's quota; the figures live in `$kabo-start`'s Estimates block — is disclosed inside that flow before anything runs, and its consent popup is where they can decline.
  - The profile **exists but `onboarded_at` is empty** → an interrupted onboarding. Hand off to `$kabo-start` (read `../kabo-start/SKILL.md` and follow it in this task), which offers Continue / Start over and never re-runs a finished analysis.
  - The profile **is complete** (`onboarded_at` set) → welcome them back by handle, remind them of their plan (goal and cadence from the profile), and offer the next step from it. They can also state a request directly or use `$analyze`.
- The Kabo tools are not in this task's tool list at all → this task predates the authorization (see step 2) and the list will not refresh mid-task. **Do not** work around it by spawning a fresh non-interactive `codex exec` subprocess to make the call: non-interactive runs auto-cancel MCP tool approvals, so the call fails for reasons that have nothing to do with authorization and proves nothing about the user's own session. Instead tell the user authorization completed and to start a new task (or restart the session) — the first Kabo call there is the verification.
- The tools are visible but answer 401 → authorization did not complete; go back to step 2. **Do not** try any other authentication method.

## Hard rules

- **Do not** read, hunt for, or write any credentials file or token in an env var — it does not exist, and looking for it is itself wrong. The former `KABO_API_TOKEN` / `~/.kabo/credentials.json` were removed wholesale in 0.9.0.
- **Do not** use the shell to assemble an Authorization header and call the platform HTTP API directly to "bypass" authorization (token leak risk, and there is no token on this machine to assemble anyway).
- If the user asks how to **revoke** authorization: run `$kabo-logout`. It calls the platform's `auth_revoke_all` over the authorized connection — that revokes every device at once — and then clears the local cache.

## There is nothing else to authorize

As of 0.12.0 every creator research fetch runs **on Kabo's servers**: the platform holds the provider credentials, so there are no environment variables, provider keys, or extra MCP servers for the user to set up. `kabo` is the only server declared in this plugin's `.mcp.json`.

If a fetch comes back `blocked_setup` (the platform is missing that credential) or `unsupported` (that operation is not implemented server-side yet), it is a **platform-side gap the user cannot fix** — report it plainly, never ask them to configure a key, and never substitute another data source. `data_connector_catalog` shows the state of every connector and operation without fetching anything.

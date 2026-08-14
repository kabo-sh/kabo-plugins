---
name: kabo-login
description: Connect and authorize the Kabo platform. Open the sign-in page in a browser, complete the OAuth authorization of `codex mcp login kabo`, and verify it with one real call; no token is stored on this machine, and no credentials file is read or written.
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
codex mcp login kabo
```

A browser completes the OAuth authorization (OAuth 2.1 + PKCE on the platform side). `kabo` is the server name declared in this plugin's `.mcp.json`. Because they signed in at step 1, this should be a single consent click.

Once authorization completes, Kabo's tools are callable. If the host says the session must be restarted to renegotiate the tool list, just do that.

**If the browser never opens**: the CLI still prints the authorization URL — have the user copy it into a browser and finish the flow there; the callback returns to the waiting CLI. The Claude Code build hits the same failure as a known host bug (anthropics/claude-code#36307) and the manual-URL workaround is identical. It is not a Kabo failure and there is nothing on the platform side to fix.

**Fallback outside Codex**: anyone with a Claude account can add `https://kabo.sh/mcp` as a custom connector in claude.ai or the Claude chat desktop app (**Settings → Connectors**) and authorize it there. Say plainly what it costs — that surface is **data only**: the platform tools answer, but skill routing, signed download, signature verification, and isolated execution do not exist on it. Offer it as a fallback, never as the recommended path.

## 3. Verify with a real call

Confirm instead of claiming success: call Kabo's `registry_skill_search` with query `youtube`.

- Results returned → tell the user they are authorized, name a couple of the skills that came back, and mention they can state a creator research need directly or use `$analyze`.
- 401 or the tool is invisible → authorization did not complete; go back to step 2. **Do not** try any other authentication method.

## Hard rules

- **Do not** read, hunt for, or write any credentials file or token in an env var — it does not exist, and looking for it is itself wrong. The former `KABO_API_TOKEN` / `~/.kabo/credentials.json` were removed wholesale in 0.9.0.
- **Do not** use the shell to assemble an Authorization header and call the platform HTTP API directly to "bypass" authorization (token leak risk, and there is no token on this machine to assemble anyway).
- If the user asks how to **revoke** authorization: run `$kabo-logout`. It calls the platform's `auth_revoke_all` over the authorized connection — that revokes every device at once — and then clears the local cache.

## There is nothing else to authorize

As of 0.12.0 every creator research fetch runs **on Kabo's servers**: the platform holds the provider credentials, so there are no environment variables, provider keys, or extra MCP servers for the user to set up. `kabo` is the only server declared in this plugin's `.mcp.json`.

If a fetch comes back `blocked_setup` (the platform is missing that credential) or `unsupported` (that operation is not implemented server-side yet), it is a **platform-side gap the user cannot fix** — report it plainly, never ask them to configure a key, and never substitute another data source. `data_connector_catalog` shows the state of every connector and operation without fetching anything.

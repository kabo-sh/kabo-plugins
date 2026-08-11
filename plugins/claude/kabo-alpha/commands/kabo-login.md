---
description: Connect and authorize the Kabo platform (OAuth completed in the browser, only ever once)
---

Guide the user through Kabo's **single** authorization. This command does not authenticate by itself — it cannot, and it should not:

**Make this clear first**: there is no "terminal login" for Kabo. No Kabo token is stored on this machine, there is no credentials file, and there is nowhere to enter a token. Authorization happens only in the host's MCP connection layer; the **host** holds the token and refreshes it automatically.

## Guide the user through

1. Run `/mcp` in the session.
2. Select `kabo` (if it is not in the list, the plugin is not enabled — have the user run `claude plugin enable kabo-alpha` first).
3. Choose connect/authorize; the host opens a browser to complete login and authorization (OAuth 2.1 + PKCE).
4. Once done, **platform tools are immediately usable in this session** — no restart needed.

## Then verify

Confirm with a real call instead of just claiming success: call `mcp__plugin_kabo-alpha_kabo__registry_skill_search` with query `youtube`.

- Results returned → tell the user they are authorized, and mention they can state a request directly or use `/kabo-analyze`.
- 401 or the tool is invisible → authorization did not complete; go back to step 1. **Do not** try any other authentication method.

## Hard rules

- **Do not** read, hunt for, or write any credentials file or token in an env var — it does not exist, and looking for it is itself wrong.
- **Do not** use Bash to assemble an Authorization header and call the platform HTTP API directly to "bypass" authorization (token leak risk, and there is no token on this machine to assemble anyway).
- If the user asks how to **revoke** authorization: use the Kabo dashboard, or disconnect the `kabo` connection in `/mcp`. `/kabo-logout` clears the local cache, not the authorization.

## Third-party provider keys (unrelated to authorization; bring up only when needed)

Creator research skills need user-supplied external data source keys (their own account and quota). This is separate from Kabo authorization; mention it only when the user asks, or when a tool returns `blocked_setup`.

The configuration entry point is **the config prompt shown when enabling the plugin**: have the user run `/plugin` in an interactive session and re-enable kabo-alpha to trigger it again; sensitive fields are entered in a password box and the values go into the system keychain. The config fields that get read: `youtube_api_key`, `tubelab_api_key`, `gemini_api_key`, `scrapecreators_api_key`.

**Never** have the user paste a key into the conversation, the command line, or any file — `claude plugin install --config` does exist, but command-line arguments end up in shell history and the process list, so do not use it to pass these keys; the `claude plugin configure` subcommand does not exist, do not reference it.

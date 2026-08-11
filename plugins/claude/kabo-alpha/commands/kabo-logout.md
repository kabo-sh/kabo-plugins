---
description: Clear Kabo's local cache and trust material (skill cache / server public key / meta-guidance cache)
---

Help the user clear the cache and trust material Kabo has left on this machine.

Make this clear first: Kabo **stores no token on this machine** — there is only the one in-session `/mcp` authorization (the host holds the token), so this command has nothing to do with any local credential; it only clears caches.

1. Use Bash to run the script bundled with the plugin (`bin/` is already on PATH; the absolute path `${CLAUDE_PLUGIN_ROOT}/bin/kabo-auth` also works):

   ```
   kabo-auth logout
   ```

2. Report the script output to the user, and explain that three things were cleared:
   - `~/.kabo/skill-cache/`: downloaded and unpacked skills plus revocation markers
   - `~/.kabo/public-key.pem`: the TOFU-cached platform signing public key (it will be fetched again next time)
   - `~/.kabo/meta-guidance.json`: the signature-verified dynamic routing guidance cache

3. If what the user wants is **revoking authorization on the platform side** (rather than clearing the local cache), tell them: use the Kabo dashboard, or disconnect the `kabo` connection in the host's `/mcp` connectors. There is no token list left on this machine to revoke.

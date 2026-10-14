#!/bin/sh
# skill-asset-install.sh - the PostToolUse command for registry_skill_asset in hooks/hooks.json. Same
# shape as persist-envelope.sh: a GUI-launched host may not have node on PATH, so resolve one
# (scripts/lib/node-resolve.sh) and exec bin/skill-asset-install --hook with it; stdin (the hook
# event) and stdout (the hook JSON) pass straight through.
#
# Exits 0 when no node can be found, like persist-envelope.sh: the tool result then reaches the model
# unchanged and the file is simply not cached, so the next read fetches it again.
case "$0" in */*) here="${0%/*}" ;; *) here=. ;; esac
root="$(CDPATH= cd -- "$here/../.." && pwd)" || exit 0
. "$root/scripts/lib/node-resolve.sh" || exit 0
kabo_resolve_node || exit 0
exec "$KABO_RESOLVED_NODE" "$root/bin/skill-asset-install" --hook

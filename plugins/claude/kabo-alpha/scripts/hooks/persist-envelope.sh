#!/bin/sh
# persist-envelope.sh - the PostToolUse command in hooks/hooks.json. Same shape and the same reason
# as session-start.sh: a GUI-launched host may not have node on PATH, so resolve one
# (scripts/lib/node-resolve.sh) and exec scripts/hooks/persist-envelope.js with it; stdin (the hook
# event) and stdout (the hook JSON) pass straight through.
#
# The one deliberate difference from session-start.sh: when no node can be found this exits 0, not
# 2. Exit 2 is how a hook gets its stderr shown to the user, which is right for a SessionStart that
# governs skill sync and revocations. It is wrong here - failing to stage an envelope only costs
# the slow path the runner already knows how to take, and interrupting a working run to announce a
# missed optimization would be a worse outcome than the optimization is worth.
# Plugin root from this file's own location, with builtins only: `dirname` is an external command
# and may be unreachable on the very PATH this file exists to work around.
case "$0" in */*) here="${0%/*}" ;; *) here=. ;; esac
root="$(CDPATH= cd -- "$here/../.." && pwd)" || exit 0
. "$root/scripts/lib/node-resolve.sh" || exit 0
kabo_resolve_node || exit 0
exec "$KABO_RESOLVED_NODE" "$root/scripts/hooks/persist-envelope.js" "$@"

#!/bin/sh
# session-start.sh - the SessionStart command in hooks/hooks.json. Same job as bin/kabo-headers.sh:
# resolve a node the GUI-launched host may not see on PATH (scripts/lib/node-resolve.sh) and exec
# scripts/hooks/session-start.js with it; stdin (the hook event) and stdout (the hook JSON) pass
# straight through. When no node can be found it exits 2 with one stderr sentence - for a
# SessionStart hook exit 2 is the code whose stderr the host shows to the user, which is the point:
# before this, the hook simply never ran and the first sign of trouble was the host's own 401 prompt.
# Plugin root from this file's own location, with builtins only: `dirname` is an external command
# and may be unreachable on the very PATH this file exists to work around. Not $CLAUDE_PLUGIN_ROOT
# either - that is a config-file substitution, not a guaranteed process variable (common.js).
# CDPATH= : an inherited CDPATH makes POSIX `cd` echo the resolved directory to stdout when the
# operand is relative, which would land a second line inside $root; `--` keeps a dash-led $0 harmless.
case "$0" in */*) here="${0%/*}" ;; *) here=. ;; esac
root="$(CDPATH= cd -- "$here/../.." && pwd)" || exit 2
. "$root/scripts/lib/node-resolve.sh"
kabo_resolve_node || kabo_fail_no_node
exec "$KABO_RESOLVED_NODE" "$root/scripts/hooks/session-start.js" "$@"

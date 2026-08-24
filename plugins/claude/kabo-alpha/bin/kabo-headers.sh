#!/bin/sh
# kabo-headers.sh - the entry point .mcp.json names as headersHelper. The host spawns it once per
# MCP request. It does one thing: find a node binary the GUI-launched host may not have on PATH
# (scripts/lib/node-resolve.sh - $KABO_NODE, then <data root>/node-path recorded at sign-in, then
# PATH, then the usual install locations) and exec bin/kabo-headers with it. exec replaces this
# shell, so stdin/stdout/stderr pass straight through and bin/kabo-headers' contract is untouched:
# one line of JSON on stdout, or 0 bytes. This file never reads the credential file, never writes
# to stdout (except in --which mode, which the host never uses), and spawns nothing.
#
# --which: print the node this shim would use and exit 0 - for `kabo-auth status`-style diagnosis
# and for the SessionStart hook, which runs it in the host's own environment to report "no node"
# as its own sentence. Any other argument (--probe) is passed through to bin/kabo-headers.
#
# Failure (no node anywhere): exit 2, 0 bytes on stdout, one stderr line naming the fix.
# Windows native: no POSIX sh means this file cannot be exec'd; there node must be on the host PATH.
# Plugin root from this file's own location, with builtins only: `dirname` is an external command
# and may be unreachable on the very PATH this file exists to work around. Not $CLAUDE_PLUGIN_ROOT
# either - that is a config-file substitution, not a guaranteed process variable (common.js).
# CDPATH= : an inherited CDPATH makes POSIX `cd` echo the resolved directory to stdout when the
# operand is relative, which would land a second line inside $root; `--` keeps a dash-led $0 harmless.
case "$0" in */*) here="${0%/*}" ;; *) here=. ;; esac
root="$(CDPATH= cd -- "$here/.." && pwd)" || exit 2
. "$root/scripts/lib/node-resolve.sh"
kabo_resolve_node || kabo_fail_no_node
if [ "${1:-}" = "--which" ]; then
  printf '%s\n' "$KABO_RESOLVED_NODE"
  exit 0
fi
exec "$KABO_RESOLVED_NODE" "$root/bin/kabo-headers" "$@"

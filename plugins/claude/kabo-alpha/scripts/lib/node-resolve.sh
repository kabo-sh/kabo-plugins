#!/bin/sh
# node-resolve.sh - shared node lookup for the two POSIX sh entry points the host runs directly:
# bin/kabo-headers.sh (the headersHelper in .mcp.json) and scripts/hooks/session-start.sh (the
# SessionStart hook). Sourced with `.`, never executed.
#
# Why it exists (2026-08-23): a GUI-launched host - the Claude Code desktop app above all - does not
# inherit the user's shell PATH. nvm, volta, fnm and Homebrew all live outside the system PATH, so
# `#!/usr/bin/env node` and a bare `node ...` hook command both fail in that process, with nothing
# telling the user why: the helper emits 0 bytes, the request 401s, and the host answers with its
# own /mcp sign-in prompt every session. This file finds a node the host cannot see.
#
# Resolution order - first executable wins:
#   1. $KABO_NODE                               explicit override, for the rare setup nothing below fits
#   2. <data root>/node-path                    the node `kabo-auth login` ran under (it wrote the file:
#                                               a node that completed the sign-in is a node that exists)
#   3. command -v node                          the host had a PATH after all
#   4. well-known locations                     /usr/local/bin, Homebrew, nvm (newest version), volta,
#                                               fnm (newest version), /usr/bin, snap, ~/.local/bin
#      ($KABO_NODE_SYSROOT, default empty, is prefixed to the fixed absolute locations in step 4; the
#       test suite points it at an empty directory to simulate a machine with no node at all, since
#       a real /usr/bin/node cannot be hidden from a test. HOME / NVM_DIR cover the per-user trees.)
#
# Discipline: only shell builtins and globbing - no external command runs before the caller's final
# exec, because the helper runs on every MCP request and one extra process would double its cost.
# No `node --version` probe for the same reason; `[ -x ]` is the whole test. Nothing here reads the
# credential file, and nothing here writes to stdout: the helper's stdout is the header channel, and
# the contract is "one line of JSON or 0 bytes". Failure is exit 2 (the callers' "not a sign-in
# problem" code) with ONE stderr sentence that names the fix and deliberately does not name
# /kabo-login - the SessionStart hook treats that substring as the signature of a sign-in verdict.
#
# Windows native: a .sh file cannot be exec'd by the host without a POSIX sh; there the host still
# needs node on PATH (see README, "About .mcp.json").

KABO_NODE_MISSING_MESSAGE='Kabo could not find a node executable to run its credential helper (the app was started without your shell PATH). Set KABO_NODE=/path/to/node, or install node system-wide / symlink it into /usr/local/bin, then quit and relaunch the app and start a new session.'

# kabo_newest_in DIR SUFFIX - among DIR/v<MAJOR>.<MINOR>.<PATCH>* pick the highest version whose
# "$dir$SUFFIX" is executable. Pure sh numeric compare: macOS `sort` has no -V, and `ls` would be a
# process. Sets KABO_RESOLVED_NODE and returns 0, or returns 1 with nothing set.
kabo_newest_in() {
  _kn_dir="$1"; _kn_suffix="$2"
  _kn_best=''; _kn_bmaj=-1; _kn_bmin=-1; _kn_bpat=-1
  [ -d "$_kn_dir" ] || return 1
  for _kn_cand in "$_kn_dir"/v*; do
    [ -x "$_kn_cand$_kn_suffix" ] || continue
    _kn_ver="${_kn_cand##*/}"; _kn_ver="${_kn_ver#v}"
    _kn_save_ifs="$IFS"; IFS=.
    # shellcheck disable=SC2086
    set -- $_kn_ver
    IFS="$_kn_save_ifs"
    _kn_maj="${1:-0}"; _kn_min="${2:-0}"; _kn_pat="${3:-0}"
    # Anything not purely numeric (e.g. "v20-nightly") is not a version we can rank; skip it.
    case "$_kn_maj$_kn_min$_kn_pat" in *[!0-9]*) continue ;; esac
    if [ "$_kn_maj" -gt "$_kn_bmaj" ] \
      || { [ "$_kn_maj" -eq "$_kn_bmaj" ] && [ "$_kn_min" -gt "$_kn_bmin" ]; } \
      || { [ "$_kn_maj" -eq "$_kn_bmaj" ] && [ "$_kn_min" -eq "$_kn_bmin" ] && [ "$_kn_pat" -gt "$_kn_bpat" ]; }; then
      _kn_best="$_kn_cand$_kn_suffix"; _kn_bmaj="$_kn_maj"; _kn_bmin="$_kn_min"; _kn_bpat="$_kn_pat"
    fi
  done
  [ -n "$_kn_best" ] || return 1
  KABO_RESOLVED_NODE="$_kn_best"
  return 0
}

# kabo_resolve_node - sets KABO_RESOLVED_NODE and returns 0, or returns 2 with nothing set.
kabo_resolve_node() {
  KABO_RESOLVED_NODE=''
  _kr_home="${HOME:-/nonexistent}"
  _kr_data_root="${KABO_DATA_ROOT:-$_kr_home/.kabo}"

  # 1. explicit override - absolute paths only: a bare name would be -x-tested against the host's
  #    cwd but later exec'd through PATH, and `./node` would run a file from the project directory.
  case "${KABO_NODE:-}" in
    /*) if [ -x "$KABO_NODE" ]; then KABO_RESOLVED_NODE="$KABO_NODE"; return 0; fi ;;
  esac

  # 2. the node recorded at sign-in (first line only; a CR from an edited file is stripped).
  #    A stale marker (node upgraded, nvm version deleted) fails -x and falls through.
  if [ -r "$_kr_data_root/node-path" ]; then
    _kr_recorded=''
    IFS= read -r _kr_recorded < "$_kr_data_root/node-path" || true
    _kr_cr="$(printf '\r')"
    _kr_recorded="${_kr_recorded%"$_kr_cr"}"
    #    Absolute only, same reason as KABO_NODE (kabo-auth writes process.execPath, which is).
    case "$_kr_recorded" in
      /*) if [ -x "$_kr_recorded" ]; then KABO_RESOLVED_NODE="$_kr_recorded"; return 0; fi ;;
    esac
  fi

  # 3. PATH (command -v is a builtin; it prints a path only for something executable)
  _kr_found="$(command -v node 2>/dev/null)" || _kr_found=''
  if [ -n "$_kr_found" ] && [ -x "$_kr_found" ]; then
    KABO_RESOLVED_NODE="$_kr_found"; return 0
  fi

  # 4. well-known locations
  _kr_sys="${KABO_NODE_SYSROOT:-}"
  for _kr_c in "$_kr_sys/usr/local/bin/node" "$_kr_sys/opt/homebrew/bin/node" "$_kr_sys/opt/homebrew/opt/node/bin/node" "$_kr_sys/usr/local/opt/node/bin/node"; do
    if [ -x "$_kr_c" ]; then KABO_RESOLVED_NODE="$_kr_c"; return 0; fi
  done
  kabo_newest_in "${NVM_DIR:-$_kr_home/.nvm}/versions/node" '/bin/node' && return 0
  if [ -x "$_kr_home/.volta/bin/node" ]; then KABO_RESOLVED_NODE="$_kr_home/.volta/bin/node"; return 0; fi
  kabo_newest_in "$_kr_home/.local/share/fnm/node-versions" '/installation/bin/node' && return 0
  for _kr_c in "$_kr_sys/usr/bin/node" "$_kr_sys/snap/bin/node" "$_kr_home/.local/bin/node"; do
    if [ -x "$_kr_c" ]; then KABO_RESOLVED_NODE="$_kr_c"; return 0; fi
  done
  return 2
}

# kabo_fail_no_node - the one failure path: one stderr line, 0 bytes on stdout, exit 2.
kabo_fail_no_node() {
  printf '%s\n' "$KABO_NODE_MISSING_MESSAGE" >&2
  exit 2
}

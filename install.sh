#!/usr/bin/env bash
# Kabo plugin installer — the one-shot entry point behind `curl -fsSL … | bash`.
#
# This script does five things and deliberately only these five: register (or refresh) the marketplace,
# install (or update) the plugin, (on the Claude side) detect a pre-plugin direct MCP registration of
# the same endpoint and clear it with consent, (on the Claude side, with consent) start the plugin's
# own sign-in command for you, and tell you what to do next.
# It does **not** install Claude Code or Codex for you, write any config file, use sudo, or
# ever read or write credential material. Signing in is done end to end by the plugin's own
# kabo-auth device flow (on the Codex side it is host OAuth: `codex mcp login kabo --scopes …`,
# full scope set in CODEX_LOGIN_SCOPES below) — the
# installer merely types that command for you, saving the "install → restart → one more
# command → restart again" round trip; it never touches a byte of where credentials are
# created or stored.
# The reasoning: `curl | bash` is the most trust a user can extend, and the less the script
# does, the cheaper that trust is.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kabo-sh/kabo-plugins/main/install.sh | bash
#   ./install.sh --client codex --repo /path/to/kabo-plugins   # from a clone, no network
#   ./install.sh --help
set -euo pipefail

# ====== Overridable constants ======
# The default source is this repository. Both CLIs resolve it with `git clone`, so a local path
# works in place of the slug and needs no network at all.
REPO_SLUG="${KABO_INSTALL_REPO:-kabo-sh/kabo-plugins}"
REPO_REF="${KABO_INSTALL_REF:-}"

# Codex clones the marketplace repo itself, so a remote source pulls the whole tree unless it is
# told otherwise. These two paths are everything the Codex plugin needs; the Claude variant and
# every other directory stay out of the clone.
CODEX_SPARSE_MARKETPLACE=".agents/plugins/marketplace.json"
CODEX_SPARSE_PLUGIN="plugins/codex/kabo-alpha"

# The two marketplace names differ, and one is a prefix of the other (kabo-plugins /
# kabo-plugins-codex). Every presence test must compare the **whole field**, never a grep
# substring — otherwise installing for Claude would read Codex's entry as "already registered"
# and then fail at the install step with an error that explains nothing.
CLAUDE_MARKETPLACE="kabo-plugins"
CODEX_MARKETPLACE="kabo-plugins-codex"
PLUGIN_NAME="kabo-alpha"

# Claude's floor comes from when ${CLAUDE_PLUGIN_ROOT} inside a headersHelper is interpolated
# (the README has the full reasoning): an older host runs the literal path, never gets a header,
# and 401s. The host's own OAuth discovery chain can complete now that the server publishes the
# metadata it needs, but what it leaves behind is a host-held token that this plugin's sign-in,
# logout, and telemetry model does not manage — the supported path is always the /kabo-login
# device flow. Better to stop here than to let someone install into an unsupported
# authorization path.
CLAUDE_MIN_VERSION="2.1.195"
# No version floor for Codex: whether the `codex plugin` subcommand exists is a better test than
# any version number.

# Codex now also accepts a bare `codex mcp login kabo`. The installer still prints the explicit
# contract scope set as the compatibility path, so behaviour never depends on a host version's
# default scopes. Converting this list's commas to spaces yields exactly the ordered scope tokens
# of OAUTH_SCOPE in the Claude variant's credentials.js; tests pin the two against drift.
CODEX_LOGIN_SCOPES="openid,offline_access,account:read,registry,telemetry,data"

# ====== Output ======
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_OFF=''
fi

info()  { printf '%s==>%s %s\n' "$C_BLUE" "$C_OFF" "$1"; }
ok()    { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn()  { printf '%s  !%s %s\n' "$C_YELLOW" "$C_OFF" "$1" >&2; }
fail()  { printf '%sError:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2; exit 1; }
dim()   { printf '%s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }

usage() {
  cat <<'USAGE'
Kabo plugin installer

Usage:
  install.sh [--client claude|codex|claude,codex] [--repo OWNER/REPO] [--ref GIT_REF] [--yes]

Options:
  --client   Which hosts to install for; comma-separated for more than one
             ("both" is accepted as a synonym for claude,codex). Skips the menu.
  --repo     Marketplace source: owner/repo, or a local path to a clone
             (default: kabo-sh/kabo-plugins).
  --ref      Git ref to install from (branch or tag).
  --yes, -y  Non-interactive: install for every supported host found, no prompt.
  --dry-run  Print every command this would run, without running any of them.
  --help     Show this message.

Environment:
  KABO_INSTALL_REPO, KABO_INSTALL_REF  Same as --repo / --ref.

For a remote Codex marketplace, only .agents/plugins/marketplace.json and
plugins/codex/kabo-alpha are fetched — nothing else in the repository is cloned.

The installer never installs Claude Code or Codex for you, never uses sudo, and never
reads or writes your credentials. After installing the Claude plugin it checks for a
pre-plugin direct MCP registration of the Kabo endpoint (removal is offered, never
automatic), and offers to start the plugin's own terminal sign-in (kabo-auth login)
for you; decline either, and the step it prints at the end covers it.
USAGE
}

# ====== Arguments ======
CLIENT="${KABO_CLIENT:-}"
ASSUME_YES=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --client) CLIENT="${2:-}"; shift 2 ;;
    --client=*) CLIENT="${1#*=}"; shift ;;
    --repo) REPO_SLUG="${2:-}"; shift 2 ;;
    --repo=*) REPO_SLUG="${1#*=}"; shift ;;
    --ref) REPO_REF="${2:-}"; shift 2 ;;
    --ref=*) REPO_REF="${1#*=}"; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "Unknown argument: $1" ;;
  esac
done

# The target is a **set**, not a single choice: both hosts can coexist on one machine, and
# "which one" and "how many" are two sides of the same question. --client takes a comma-separated
# list; "both" is kept as a compatible spelling.
declare -a TARGETS=()

want() { # want <claude|codex> — is it in the target set
  local needle="$1" t
  for t in ${TARGETS[@]+"${TARGETS[@]}"}; do [ "$t" = "$needle" ] && return 0; done
  return 1
}

add_target() {
  want "$1" || TARGETS+=("$1")
}

if [ -n "$CLIENT" ]; then
  # Accept commas or spaces: one stray space while pasting a command should not become an error.
  for token in ${CLIENT//,/ }; do
    case "$token" in
      claude) add_target claude ;;
      codex)  add_target codex ;;
      both)   add_target claude; add_target codex ;;
      *) fail "--client must be claude, codex, or claude,codex (got: $token)" ;;
    esac
  done
fi

# ====== stdin under curl | bash ======
# When piped, the script itself owns stdin, and child commands inherit a pipe that has already
# been read to the end: an interactive question gets EOF immediately, and a CLI's trust prompt
# looks like an automatic refusal. So anything that might talk to the user is explicitly wired to
# /dev/tty, falling back to /dev/null where there is none (CI, containers) so it fails cleanly
# down the non-interactive path.
# The test has to be "can it actually be opened", not [ -r /dev/tty ]: with no controlling
# terminal that device node still exists and passes the permission check, so the test succeeds
# and the open returns ENXIO. The difference is a harmless downgrade in CI versus a failure with
# a baffling error message.
if { : >/dev/tty; } 2>/dev/null && { : </dev/tty; } 2>/dev/null; then
  HAS_TTY=1
else
  HAS_TTY=0
fi

# Every command that actually runs is echoed verbatim first. A `curl | bash` user cannot see the
# script, so this is the only place they can check what it actually touched.
run_cli() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s    [dry-run] %s%s\n' "$C_DIM" "$*" "$C_OFF"
    return 0
  fi
  printf '%s    %s%s\n' "$C_DIM" "$*" "$C_OFF"
  if [ "$HAS_TTY" -eq 1 ]; then
    "$@" </dev/tty
  else
    "$@" </dev/null
  fi
}

prompt() { # prompt <varname> <text> <default>
  local __var="$1" __text="$2" __default="$3" __reply=''
  if [ "$HAS_TTY" -eq 0 ] || [ "$ASSUME_YES" -eq 1 ]; then
    printf -v "$__var" '%s' "$__default"
    return 0
  fi
  printf '%s' "$__text" > /dev/tty
  IFS= read -r __reply < /dev/tty || __reply=''
  [ -n "$__reply" ] || __reply="$__default"
  printf -v "$__var" '%s' "$__reply"
}

# ====== Version comparison ======
# sort -V is the only semantic comparison that behaves the same across GNU and BSD. Field
# splitting is not hand-written here because comparisons like "2.1.195" against "2.1.1950" are
# very easy to get backwards by hand.
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

# ====== Detection ======
# Each client lands in one of four states, and the wording is reused verbatim in the final report:
#   missing        not installed
#   no-plugin-cmd  installed, but this build has no plugin subcommand
#   too-old        installed with a plugin subcommand, but below the floor
#   ready          installable
CLAUDE_STATE='missing'; CLAUDE_VERSION=''
CODEX_STATE='missing';  CODEX_VERSION=''

detect_claude() {
  command -v claude >/dev/null 2>&1 || { CLAUDE_STATE='missing'; return; }
  CLAUDE_VERSION="$(claude --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -n 1 || true)"
  if ! claude plugin --help >/dev/null 2>&1; then CLAUDE_STATE='no-plugin-cmd'; return; fi
  # If the version cannot be parsed, **let it through** rather than blocking: failing to read a
  # version is our parsing problem, not the user's environment problem, and letting the CLI report
  # the real error beats guessing here.
  if [ -n "$CLAUDE_VERSION" ] && ! version_ge "$CLAUDE_VERSION" "$CLAUDE_MIN_VERSION"; then
    CLAUDE_STATE='too-old'; return
  fi
  CLAUDE_STATE='ready'
}

detect_codex() {
  command -v codex >/dev/null 2>&1 || { CODEX_STATE='missing'; return; }
  CODEX_VERSION="$(codex --version 2>/dev/null | head -n 1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -n 1 || true)"
  if ! codex plugin --help >/dev/null 2>&1; then CODEX_STATE='no-plugin-cmd'; return; fi
  CODEX_STATE='ready'
}

describe_state() { # describe_state <state> <version>
  case "$1" in
    ready)         [ -n "$2" ] && printf 'installed (%s)' "$2" || printf 'installed' ;;
    too-old)       printf 'installed (%s) — too old, needs %s or newer' "$2" "$CLAUDE_MIN_VERSION" ;;
    no-plugin-cmd) printf 'installed (%s) — this build has no plugin support' "${2:-unknown}" ;;
    missing)       printf 'not found' ;;
  esac
}

state_mark() { [ "$1" = 'ready' ] && printf '%s✓%s' "$C_GREEN" "$C_OFF" || printf '%s✗%s' "$C_RED" "$C_OFF"; }

# ====== Install: Claude ======
claude_marketplace_present() {
  # Prefer --json (whole-field test); fall back to text matching on older builds that lack the
  # flag, still anchored on word boundaries.
  local listing
  if listing="$(claude plugin marketplace list --json 2>/dev/null)" && [ -n "$listing" ]; then
    printf '%s' "$listing" | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${CLAUDE_MARKETPLACE}\""
  else
    claude plugin marketplace list 2>/dev/null | grep -qE "(^|[^-[:alnum:]])${CLAUDE_MARKETPLACE}([^-[:alnum:]]|\$)"
  fi
}

claude_plugin_present() {
  claude plugin list --json 2>/dev/null \
    | grep -q "\"id\"[[:space:]]*:[[:space:]]*\"${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}\""
}

# Installed does **not** mean enabled: `claude plugin install` states plainly that a plugin is
# disabled by default. So the enabled state is read back rather than announced after running
# enable — one "installed and enabled" line buys a plugin that is installed and does nothing,
# which is far worse than not printing the line at all.
# Scanned object by object: enabled and id live in the same JSON object, id first.
claude_plugin_enabled() {
  claude plugin list --json 2>/dev/null | awk -v id="\"${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}\"" '
    /"id"[[:space:]]*:/            { cur = (index($0, id) > 0) }
    cur && /"enabled"[[:space:]]*:[[:space:]]*true/ { found = 1 }
    END { exit found ? 0 : 1 }'
}

install_claude() {
  info "Claude Code"

  if claude_marketplace_present; then
    ok "marketplace \"$CLAUDE_MARKETPLACE\" already registered"
    # Registered does not mean current: the marketplace is a git clone, and neither install nor
    # update refreshes it on its own. Without this step, everything below sees the snapshot from
    # the day the marketplace was added — which is exactly how re-running the installer on an
    # already-set-up machine used to hand people the old version.
    run_cli claude plugin marketplace update "$CLAUDE_MARKETPLACE" \
      || warn "Could not refresh the marketplace clone; continuing with the local copy (it may be stale)."
  else
    local source="$REPO_SLUG"
    [ -n "$REPO_REF" ] && source="${REPO_SLUG}@${REPO_REF}"
    run_cli claude plugin marketplace add "$source" \
      || fail "Could not register the marketplace from $source. The host clones it with git, so check that the name is right and that git can reach it, then try again."
    ok "marketplace registered"
  fi

  if claude_plugin_present; then
    # For an installed plugin, `plugin install` is a strict no-op: the host answers
    # "already installed" and keeps the old version, even against a freshly refreshed clone.
    # The actual upgrade command is `plugin update`. A failed update is not a failed install:
    # the old version is still there and still works.
    if run_cli claude plugin update "${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}"; then
      ok "plugin updated to the marketplace's latest version (restart to apply)"
    else
      warn "claude plugin update failed; the installed version stays as it was. You can retry with: claude plugin update ${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}"
    fi
  # Check again afterwards rather than trusting the exit code: a repeat install returns 0 on some
  # versions and non-zero on others, and "is it there afterwards" is the fact we actually care about.
  elif ! run_cli claude plugin install "${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}"; then
    claude_plugin_present || fail "claude plugin install failed and ${PLUGIN_NAME} is not installed."
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    run_cli claude plugin enable "$PLUGIN_NAME"
    ok "plugin installed and enabled"
  else
    # Do not enable something already enabled: that fails with "already enabled" and prints a red
    # cross, making a perfectly normal re-run look like something went wrong.
    claude_plugin_enabled || run_cli claude plugin enable "$PLUGIN_NAME" || true
    if claude_plugin_enabled; then
      ok "plugin installed and enabled"
    else
      ok "plugin installed"
      warn "It is installed but not enabled. Run: claude plugin enable ${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}"
    fi
  fi
  CLAUDE_DONE=1
}

# ====== Install: Codex ======
codex_marketplace_present() {
  # The output is a two-column `MARKETPLACE  ROOT` table; compare the whole first field (see the
  # prefix trap above).
  codex plugin marketplace list 2>/dev/null \
    | awk -v want="$CODEX_MARKETPLACE" 'NR>1 && $1==want {found=1} END {exit found?0:1}'
}

install_codex() {
  info "Codex"

  if codex_marketplace_present; then
    ok "marketplace \"$CODEX_MARKETPLACE\" already registered"
    # Same reasoning as the Claude side: a Git marketplace snapshot never refreshes itself.
    # A local-path marketplace has no snapshot, so upgrade fails with "not configured as a
    # Git marketplace" — that is not an error, the live directory is already current.
    run_cli codex plugin marketplace upgrade "$CODEX_MARKETPLACE" \
      || warn "Could not refresh the marketplace snapshot (a local-path marketplace has none); continuing."
  else
    local -a add_args=("$REPO_SLUG")
    [ -n "$REPO_REF" ] && add_args+=(--ref "$REPO_REF")
    # A local path marketplace is already a working tree — sparse applies to a clone only.
    if [ ! -d "$REPO_SLUG" ]; then
      add_args+=(--sparse "$CODEX_SPARSE_MARKETPLACE" --sparse "$CODEX_SPARSE_PLUGIN")
    fi
    run_cli codex plugin marketplace add "${add_args[@]}" \
      || fail "Could not register the marketplace from $REPO_SLUG. Codex clones it with git, so check that the name is right and that git can reach it, then try again."
    ok "marketplace registered"
  fi

  # Unlike Claude, Codex's add reinstalls an already-installed plugin from the current snapshot
  # (verified: an old version gets replaced), so "refresh the snapshot, re-run add" is the whole
  # upgrade path on this side — no separate update command needed.
  if ! run_cli codex plugin add "${PLUGIN_NAME}@${CODEX_MARKETPLACE}"; then
    # Codex's add can also return non-zero when the plugin is already installed; again, the fact
    # afterwards is what counts.
    codex plugin list --json 2>/dev/null | grep -q "$PLUGIN_NAME" \
      || fail "codex plugin add failed and ${PLUGIN_NAME} does not appear in the plugin list."
    ok "plugin was already installed"
  else
    ok "plugin installed"
  fi
  CODEX_DONE=1
}

# ====== Claude sign-in (optional, offered right after installing) ======
# An installed plugin that is not signed in gets no data at all, and "restart → /kabo-login →
# activate again" is three steps that collapse into one. So after installing the Claude plugin
# the script asks once, and on a yes it starts the sign-in command for the user.
# The boundary is unchanged: signing in is always the plugin's own kabo-auth device flow, the
# installer only launches it, and it never touches a byte of where credentials are created or
# stored.
CLAUDE_SIGNED_IN=0

# Where the plugin got installed is taken only from the host's own answer (claude plugin list
# --json). The output shape varies by version (2.1.89 differs from 2.1.2xx), so the parsing has
# to be defensive: try the common field names, and when none parses, give this step up and fall
# back to printing the instructions — guessing or hard-coding a path would break silently the
# day the host changes its install layout, with no error pointing here. JSON parsing goes to
# node rather than grep/awk: kabo-auth needs node anyway, so this adds no new dependency.
claude_plugin_root() {
  claude plugin list --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.plugins) ? parsed.plugins
            : Array.isArray(parsed?.installed) ? parsed.installed : [];
        const hit = list.find((p) => p
          && (p.id === `${process.argv[1]}@${process.argv[2]}` || p.name === process.argv[1]));
        for (const key of ["installPath", "installedPath", "path", "root", "location", "dir"]) {
          if (hit && typeof hit[key] === "string" && hit[key]) { process.stdout.write(hit[key]); return; }
        }
      } catch { /* stay silent when the shape does not match; the caller treats empty output as a parse failure */ }
    });
  ' "$PLUGIN_NAME" "$CLAUDE_MARKETPLACE"
}

offer_claude_signin() {
  [ "${CLAUDE_DONE:-0}" -eq 1 ] || return 0
  # Ask only when a real person is present: the device flow needs someone to open a browser and
  # confirm the code, and starting it automatically in an unattended run (--yes, or no tty) would
  # just block for fifteen minutes and time out.
  #
  # These three gates (tty / --yes / node) sit **before** the dry-run output because dry-run's
  # value is fidelity: if --dry-run --yes still printed the sign-in line, it would be rehearsing a
  # path a real run would never take. The gates themselves only read variables and check PATH,
  # never execute a host command, so running them early keeps the dry-run promise intact.
  [ "$HAS_TTY" -eq 1 ] || return 0
  [ "$ASSUME_YES" -eq 0 ] || return 0
  if ! command -v node >/dev/null 2>&1; then
    warn "node is not on PATH, so the installer cannot start the sign-in here. Run /kabo-login inside Claude Code instead."
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    # dry-run only shows the command that would run: a real run would open a browser and block on
    # the device-flow polling. Path resolution is still skipped — it executes a host command, and
    # dry-run's promise is to execute nothing; the wording states honestly that in a real run this
    # line is still conditional (it is also skipped when the plugin path cannot be resolved).
    printf '%s    [dry-run] node <plugin-root>/bin/kabo-auth login  (offered interactively; skipped when the plugin path cannot be resolved)%s\n' "$C_DIM" "$C_OFF"
    return 0
  fi
  local plugin_root
  plugin_root="$(claude_plugin_root || true)"
  if [ -z "$plugin_root" ] || [ ! -f "$plugin_root/bin/kabo-auth" ]; then
    # An older host's list output yields no install path: do not guess, fall back to /kabo-login
    # inside a session.
    return 0
  fi
  printf '\n'
  local reply=''
  prompt reply "Sign in to Kabo now? It prints a URL and a code to confirm in a browser on any device. [Y/n] " "Y"
  case "$reply" in
    [nN]*) return 0 ;;
  esac
  # KABO_AUTH_QUIET_NEXT_STEPS=1: on success kabo-auth prints its own "next steps" block (start a new
  # session / reconnect in the CLI), while the installer prints its own at the end based on what the probe
  # found. Two of them in one terminal and the user skips both.
  # An environment variable rather than a --quiet-next-steps flag: the kabo-auth running here belongs to
  # the already-installed plugin, which may still be an older build (`claude plugin update` only warns when
  # it fails), and an older build meeting an unknown flag dies(1) before sign-in even starts. An unknown
  # environment variable it simply ignores.
  if KABO_AUTH_QUIET_NEXT_STEPS=1 run_cli node "$plugin_root/bin/kabo-auth" login; then
    CLAUDE_SIGNED_IN=1
    verify_claude_mcp "$plugin_root"
  else
    warn "Sign-in did not complete. Run /kabo-login inside Claude Code to try again."
  fi
}

# Right after a successful sign-in, make one real probe with the plugin's own headersHelper: send a no-op
# request to the MCP endpoint carrying the credential that was just written (kabo-headers --probe: stdout is
# always 0 bytes, the verdict lives in the exit code alone — 0 the server accepted it, 1 the credential is
# not usable, 2 network/timeout so no verdict is possible, 3 the access token has already expired locally
# (the probe never renews; renewal happens on first use, so this cannot occur right after a sign-in and is
# handled only for completeness over the exit codes).
# This comes from repeated desktop reports: a successful device flow does not mean the host can connect. If
# anything in the credential file, the endpoint, or node resolution is wrong, the user only finds out after
# opening a session and having the first tool call answer 401 — and at that point the host offers its own
# /mcp flow instead. Probing here says it plainly and points back at /kabo-login or kabo-auth status.
#
# Since 2026-08-23 the probe goes through bin/kabo-headers.sh, the same shim the host points at in
# .mcp.json: it finds node via $KABO_NODE, then ~/.kabo/node-path (the node recorded at sign-in), then PATH,
# then common install locations, and execs the real helper. Using the same shim exercises exactly the
# resolution path the host will take, and prints the node it resolved (--which). An older plugin without the
# shim falls back to node <helper> --probe.
# One thing this still cannot prove: a desktop app launched from the GUI may have a different PATH/HOME than
# we do here — which is why the shim reads the recorded node-path and the closing text mentions KABO_NODE.
verify_claude_mcp() {
  local plugin_root="$1"
  local helper="$plugin_root/bin/kabo-headers"
  local shim="$plugin_root/bin/kabo-headers.sh"
  if [ ! -f "$helper" ]; then
    # An older plugin has no headersHelper: nothing to probe, so skip silently and let the closing
    # text fall back to the "not verified" wording.
    return 0
  fi
  local probe_err='' rc=0
  if [ -f "$shim" ]; then
    local resolved=''
    resolved="$(sh "$shim" --which 2>/dev/null)" || resolved=''
    if [ -n "$resolved" ]; then
      info "The credential helper will run under $resolved (recorded for the desktop app, which is launched without your shell PATH; override with KABO_NODE)."
    fi
    printf '%s    sh %s --probe%s\n' "$C_DIM" "$shim" "$C_OFF"
    # Under set -e a failing command substitution aborts the script outright, so the exit code is
    # captured with || rather than read from $?.
    probe_err="$(sh "$shim" --probe 2>&1 >/dev/null </dev/null)" || rc=$?
  else
    printf '%s    node %s --probe%s\n' "$C_DIM" "$helper" "$C_OFF"
    probe_err="$(node "$helper" --probe 2>&1 >/dev/null </dev/null)" || rc=$?
  fi
  case "$rc" in
    0)
      CLAUDE_MCP_VERIFIED=1
      info "Kabo accepted the sign-in: the MCP endpoint answered a request made with this credential."
      ;;
    1)
      CLAUDE_MCP_VERIFIED=2
      warn "Signed in, but the Kabo MCP endpoint rejected the credential."
      [ -n "$probe_err" ] && warn "$probe_err"
      warn "Run /kabo-login inside Claude Code to sign in again (or kabo-auth status if the endpoint differs)."
      ;;
    3)
      # The probe never renews, so it cannot report the server's opinion; the credential is there and
      # the first call will renew it. Use the "not verified" wording.
      CLAUDE_MCP_VERIFIED=3
      info "Signed in; the access token has already expired locally and will be renewed on first use."
      ;;
    *)
      case "$probe_err" in
        *KABO_NODE*)
          # Exit code 2 from the shim itself: not a network problem but node not being found at all —
          # and node is demonstrably on PATH here (offer_claude_signin gates on it), so the shim itself
          # must be broken. Pass its own words through; they already spell out the fix.
          CLAUDE_MCP_VERIFIED=3
          warn "Signed in, but the credential helper could not start."
          warn "$probe_err"
          ;;
        *)
          CLAUDE_MCP_VERIFIED=3
          warn "Signed in, but could not reach the Kabo MCP endpoint to confirm it (network error or timeout)."
          [ -n "$probe_err" ] && warn "$probe_err"
          warn "The credential is saved; Claude Code will verify it when the first session starts."
          ;;
      esac
      ;;
  esac
}

# ====== Stale direct MCP registration cleanup (Claude; destructive action only with consent) ======
# Born from a 2026-08-18 desktop support case: pre-plugin guidance once had users connect the
# platform directly with `claude mcp add kabo …`. After the plugin is installed that old entry is
# pure downside — the host dedupes servers by endpoint, the old entry registers the tools under the
# direct-name prefix (mcp__kabo__*, while the bundled server is plugin:kabo-alpha:kabo), which
# collides with skill-runner's tool allowlist; worse, the host keeps its own OAuth token for it,
# which this plugin's /kabo-logout cannot revoke. The installer is the one moment anything can
# discover it for the user.
# Boundaries, all three deliberate:
#   - Detection takes two matches: the name is the bare `kabo` (a get hit on the bare name proves a
#     direct registration - the bundled server registers under the plugin: prefixed name), AND the
#     get output shows this plugin's endpoint (kabo.sh, or the self-hosted deployment named by
#     KABO_API_ENDPOINT). A server that merely shares the name but points elsewhere is not ours,
#     and not one byte of it gets touched.
#   - Deleting the user's own configuration is destructive: it runs only after interactive consent;
#     --yes / no-tty runs report and print the manual commands, never delete - the same discipline
#     as the sign-in offer.
#   - Sessions already running are out of reach, a host-documented boundary: connection state
#     belongs to the session process, an external process only edits configuration, and only new
#     sessions read the result. The wording says so honestly and promises nothing immediate.
cleanup_claude_stale_mcp() {
  [ "${CLAUDE_DONE:-0}" -eq 1 ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    # The detection itself is a host command. Dry-run's promise is to execute nothing, so even the
    # read-only get does not run - only the check that would happen is shown; removal has the
    # interactive-consent gate on top in a real run, and the wording carries that honestly.
    printf '%s    [dry-run] claude mcp get kabo  (checks for a stale pre-plugin registration; removal is offered interactively)%s\n' "$C_DIM" "$C_OFF"
    return 0
  fi
  local details=''
  details="$(claude mcp get kabo 2>/dev/null)" || return 0
  if ! printf '%s' "$details" | grep -q 'kabo\.sh'; then
    if [ -z "${KABO_API_ENDPOINT:-}" ] || ! printf '%s' "$details" | grep -qF "$KABO_API_ENDPOINT"; then
      return 0
    fi
  fi

  warn "Found a direct MCP registration named 'kabo' pointing at the Kabo endpoint. It predates the plugin and now duplicates the bundled server: its tools register under a different prefix (breaking skill-runner), and the host holds an OAuth token for it that /kabo-logout cannot revoke."
  if [ "$HAS_TTY" -eq 0 ] || [ "$ASSUME_YES" -eq 1 ]; then
    warn "Remove it yourself with: claude mcp logout kabo && claude mcp remove kabo"
    return 0
  fi
  local reply=''
  prompt reply "Remove that old registration now? Sessions already open keep it until they end. [Y/n] " "Y"
  case "$reply" in
    [nN]*)
      warn "Kept. Remove it later with: claude mcp logout kabo && claude mcp remove kabo"
      return 0
      ;;
  esac
  # logout before remove: logout clears the OAuth token the host stores for this entry; deleting
  # the registration first would leave the token with no named way to clear it. logout failing
  # when there is no token is the normal case, not an error.
  run_cli claude mcp logout kabo || true
  run_cli claude mcp remove kabo || true
  if claude mcp get kabo >/dev/null 2>&1; then
    # A remove without -s only deletes the first entry found in scope order; a name registered in
    # several scopes leaves the others behind.
    warn "A registration named 'kabo' is still there (another scope). Remove it with: claude mcp remove kabo -s user (or -s project / -s local), then re-check with: claude mcp get kabo"
  else
    ok "old direct registration removed (new sessions use the plugin's bundled server)"
  fi
}

CODEX_SIGNED_IN=0

offer_codex_signin() {
  [ "${CODEX_DONE:-0}" -eq 1 ] || return 0
  # Same gates as the Claude offer, for the same reasons (tty / --yes; no node dependency here -
  # the whole flow is the host's own OAuth: `codex mcp login` opens a browser and the host holds
  # and renews the token, so neither the installer nor the plugin ever touches a credential).
  # Verified: sign-in works right after plugin add, no Codex restart needed first.
  [ "$HAS_TTY" -eq 1 ] || return 0
  [ "$ASSUME_YES" -eq 0 ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s    [dry-run] codex mcp login kabo --scopes %s  (offered interactively)%s\n' "$C_DIM" "$CODEX_LOGIN_SCOPES" "$C_OFF"
    return 0
  fi
  printf '\n'
  local reply=''
  prompt reply "Sign in to Kabo for Codex now? It opens a browser OAuth page. [Y/n] " "Y"
  case "$reply" in
    [nN]*) return 0 ;;
  esac
  if run_cli codex mcp login kabo --scopes "$CODEX_LOGIN_SCOPES"; then
    CODEX_SIGNED_IN=1
  else
    warn "Sign-in did not complete. Run: codex mcp login kabo --scopes $CODEX_LOGIN_SCOPES"
  fi
}

# ====== Main ======
printf '\n'
info "Kabo plugin installer"
dim "    source: $REPO_SLUG${REPO_REF:+ @ $REPO_REF}"
printf '\n'

detect_claude
detect_codex

info "Hosts on this machine"
printf '  %s Claude Code  %s\n' "$(state_mark "$CLAUDE_STATE")" "$(describe_state "$CLAUDE_STATE" "$CLAUDE_VERSION")"
printf '  %s Codex        %s\n' "$(state_mark "$CODEX_STATE")" "$(describe_state "$CODEX_STATE" "$CODEX_VERSION")"
printf '\n'

# Nothing is ready: say what to do about each host separately, rather than one vague
# "please install something first".
if [ "$CLAUDE_STATE" != 'ready' ] && [ "$CODEX_STATE" != 'ready' ]; then
  case "$CLAUDE_STATE" in
    missing)       warn "Claude Code: install it from https://code.claude.com/docs/en/setup" ;;
    no-plugin-cmd) warn "Claude Code: this build has no 'claude plugin' command. Update with: npm install -g @anthropic-ai/claude-code@latest" ;;
    too-old)       warn "Claude Code $CLAUDE_VERSION is below $CLAUDE_MIN_VERSION. Update with: npm install -g @anthropic-ai/claude-code@latest" ;;
  esac
  case "$CODEX_STATE" in
    missing)       warn "Codex: install it from https://developers.openai.com/codex/cli" ;;
    no-plugin-cmd) warn "Codex ${CODEX_VERSION:-} has no 'codex plugin' command. Update Codex and re-run." ;;
  esac
  fail "No supported host is ready on this machine."
fi

# Pick the targets. Explicit flag > non-interactive default > interactive multi-select menu.
if [ "${#TARGETS[@]}" -gt 0 ]; then
  want claude && { [ "$CLAUDE_STATE" = 'ready' ] || fail "Claude Code is not ready: $(describe_state "$CLAUDE_STATE" "$CLAUDE_VERSION")"; }
  want codex  && { [ "$CODEX_STATE"  = 'ready' ] || fail "Codex is not ready: $(describe_state "$CODEX_STATE" "$CODEX_VERSION")"; }
elif [ "$HAS_TTY" -eq 0 ] || [ "$ASSUME_YES" -eq 1 ]; then
  # Unattended: install for every ready host, and say so — a silent automatic choice leaves the
  # user thinking they made it.
  [ "$CLAUDE_STATE" = 'ready' ] && add_target claude
  [ "$CODEX_STATE"  = 'ready' ] && add_target codex
  info "Non-interactive: installing for ${TARGETS[*]}"
else
  # Multi-select, not single-select: the two hosts coexist perfectly well, and making someone run
  # the script twice to get both is a step the script invented for itself. The menu lists only
  # hosts that can actually be installed, numbered in listing order — offering an option that
  # cannot work only buys a choice that is guaranteed to fail.
  declare -a options=() labels=()
  [ "$CLAUDE_STATE" = 'ready' ] && { options+=('claude'); labels+=('Claude Code'); }
  [ "$CODEX_STATE"  = 'ready' ] && { options+=('codex');  labels+=('Codex'); }

  # The default is "all of them": when every installable host is on screen, installing all is what
  # nearly everyone means, and the few who don't only have to type one number.
  default_choice=''
  for idx in $(seq 1 "${#options[@]}"); do
    default_choice="${default_choice:+$default_choice,}$idx"
  done

  info "Install the Kabo plugin for which hosts?"
  i=1
  for label in "${labels[@]}"; do
    printf '  %d) %s\n' "$i" "$label"
    i=$((i + 1))
  done
  printf '\n'
  dim "  Pick one or more, comma-separated (for example 1 or 1,2)."

  prompt choice "Select [$default_choice]: " "$default_choice"
  for token in ${choice//,/ }; do
    case "$token" in
      ''|*[!0-9]*) fail "Not a number: $token" ;;
    esac
    [ "$token" -ge 1 ] && [ "$token" -le "${#options[@]}" ] \
      || fail "Choose numbers between 1 and ${#options[@]} (got: $token)."
    add_target "${options[$((token - 1))]}"
  done
  [ "${#TARGETS[@]}" -gt 0 ] || fail "Nothing selected."
  printf '\n'
fi

CLAUDE_DONE=0
CODEX_DONE=0
# Result of the one real connection check made after signing in: 0 not verified (not signed in, or
# dry-run), 1 the server accepted the credential, 2 the server rejected it (credential unusable),
# 3 no verdict possible (network). Affects the closing text only, never the exit code.
CLAUDE_MCP_VERIFIED=0

# The order is fixed as claude → codex, matching the list above; a failure in the first aborts the
# second (set -e), which is intended: a failed install followed by a block of success output is
# the hardest thing to read.
want claude && install_claude
want codex  && { [ "$CLAUDE_DONE" -eq 1 ] && printf '\n'; install_codex; }

# The stale-registration cleanup runs before the sign-in offer: with the duplicate handled first,
# the first new session after signing in does not see two copies of kabo.
cleanup_claude_stale_mcp

# The Claude sign-in offer comes after both installs are done: the device flow blocks waiting for
# a browser confirmation, and putting it in the middle would split the Codex install output with
# a long pause.
offer_claude_signin
offer_codex_signin

# ====== Next steps ======
# The authorization entry points differ per host (Claude's device flow versus Codex's host
# OAuth), and the Claude side may have just been completed. These lines are the part users
# actually follow, so they are written per host and per signed-in state rather than merged into
# one generic hint.
printf '\n'
info "Done."
printf '\n'

if [ "$CLAUDE_DONE" -eq 1 ]; then
  printf '%sClaude Code%s\n' "$C_BLUE" "$C_OFF"
  if [ "$CLAUDE_SIGNED_IN" -eq 1 ]; then
    # The first sentence must contain no slash command at all: desktop users follow it literally, and
    # "start a new session" is the only activation path that works on every host — terminal, IDE
    # extension, and the desktop app alike. Because a new session always works, the CLI's reconnect
    # subcommand and /reload-plugins are demoted to a parenthetical second sentence and labelled CLI:
    # people on the desktop app used to copy the slash command out of the first sentence and get taken
    # over by the host's own OAuth prompt, which is exactly the loop this text exists to kill.
    # The opening sentence branches on what the post-sign-in probe actually found (case rather than
    # if/else: the tests pin the text between this branch and the first else). When the endpoint
    # rejected the credential we must not say the tools are ready — the user would open a session,
    # hit a 401, and be handed the host's own /mcp flow, so point back at the plugin's own commands.
    case "$CLAUDE_MCP_VERIFIED" in
      1)
        printf '  You are signed in and the Kabo endpoint accepted the credential — that was the\n'
        printf '  once-per-machine step. Start a new Claude Code session and the tools are ready.\n'
        ;;
      2)
        printf '  Signed in, but the Kabo endpoint rejected the credential (see the warning above).\n'
        printf '  Start a new Claude Code session and run /kabo-login to sign in again; if kabo-auth\n'
        printf '  status shows a different endpoint, fix KABO_API_ENDPOINT first. Then start another\n'
        printf '  new session and Kabo will work once the sign-in is fixed.\n'
        ;;
      3)
        printf '  You are signed in (the endpoint could not be reached to confirm it just now; the\n'
        printf '  first session re-checks). That was the once-per-machine step. Start a new Claude\n'
        printf '  Code session and the tools are ready.\n'
        ;;
      *)
        printf '  You are signed in — that was the once-per-machine step. Start a new Claude Code\n'
        printf '  session and the tools are ready.\n'
        ;;
    esac
    printf '  (Already in a Claude Code CLI session? /mcp reconnect plugin:kabo-alpha:kabo — CLI\n'
    printf '  2.1.205+ — or /reload-plugins on an older CLI reconnects without a restart. The\n'
    printf '  desktop app needs neither: a new session is the whole step there.)\n'
    printf '  The desktop app is launched without your shell PATH, so the sign-in recorded the node\n'
    printf '  it ran under (~/.kabo/node-path) for the app to use. If the app still reports Kabo as\n'
    printf '  unavailable, set KABO_NODE=/path/to/node in its environment, or install node\n'
    printf '  system-wide (or symlink it into /usr/local/bin); then quit and relaunch the desktop\n'
    printf '  app and start a new session.\n'
  else
    printf '  1. Start a new Claude Code session (any host: terminal, IDE extension, or the desktop\n'
    printf '     app). Already in a CLI session? /reload-plugins loads the plugin in place.\n'
    printf '  2. Run /kabo-login. It prints a URL and an 8-character code; confirm the code in a\n'
    printf '     browser on any device. You only do this once per machine.\n'
    printf '  3. If Kabo is still unavailable in that session afterwards, start a new session.\n'
    printf '     (CLI only: /mcp reconnect plugin:kabo-alpha:kabo — Claude Code CLI 2.1.205+ —\n'
    printf '     or /reload-plugins on an older CLI reconnects without a restart.)\n'
  fi
fi

if [ "$CODEX_DONE" -eq 1 ]; then
  [ "$CLAUDE_DONE" -eq 1 ] && printf '\n'
  printf '%sCodex%s\n' "$C_BLUE" "$C_OFF"
  if [ "$CODEX_SIGNED_IN" -eq 1 ]; then
    printf '  You are signed in. Restart Codex so it picks up the plugin, and trust its hooks\n'
    printf '  explicitly — installing a plugin does not trust them. Review hooks/hooks.json and\n'
    printf '  scripts/hooks/ first; they only sync skill status at session start.\n'
  else
    printf '  1. Restart Codex so it picks up the plugin.\n'
    printf '  2. Trust its hooks explicitly — installing a plugin does not trust them. Review\n'
    printf '     hooks/hooks.json and scripts/hooks/ in the plugin first; they only sync skill\n'
    printf '     status at session start.\n'
    printf '  3. Run `codex mcp login kabo --scopes %s`\n' "$CODEX_LOGIN_SCOPES"
    printf '     to authorize through your browser. Bare login is also supported; the explicit\n'
    printf '     scope list is the compatibility path that pins Kabo permissions across hosts.\n'
  fi
fi

printf '\n'
# Uninstall hints only for what was actually installed: listing the uninstall command for an
# install that never happened reads as "that got installed too".
[ "$CLAUDE_DONE" -eq 1 ] && dim "Uninstall (Claude Code): claude plugin uninstall ${PLUGIN_NAME}@${CLAUDE_MARKETPLACE}"
[ "$CODEX_DONE" -eq 1 ] && dim "Uninstall (Codex): codex plugin remove ${PLUGIN_NAME}"
exit 0

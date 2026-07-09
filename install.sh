#!/bin/sh
# claude-desktop-merge installer (macOS only).
#
#   curl -fsSL https://raw.githubusercontent.com/sebryu/claude-desktop-merge/main/install.sh | bash
#
# What it does: ensures a runtime (bun, or a TypeScript-capable node; installs bun
# if neither is present), downloads the tool to ~/.local/share/claude-desktop-merge,
# and drops a `claude-desktop-merge` launcher into ~/.local/bin. Nothing is run.
set -eu

REPO="sebryu/claude-desktop-merge"
NAME="claude-desktop-merge"
REF="${CLAUDE_DESKTOP_MERGE_REF:-main}"
SRC_URL="https://raw.githubusercontent.com/${REPO}/${REF}/${NAME}.ts"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/${NAME}"
BIN_DIR="${HOME}/.local/bin"
SHIM="${BIN_DIR}/${NAME}"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "${NAME} supports macOS only (found $(uname -s))."
command -v curl >/dev/null 2>&1 || die "curl is required but was not found."

# --- pick or bootstrap a runtime (bun preferred; a modern node is accepted) ---
node_runs_ts() {
  command -v node >/dev/null 2>&1 || return 1
  _probe="$(mktemp -d)/probe.ts"
  printf 'const n: number = 0; process.exit(n)\n' > "$_probe"
  node "$_probe" >/dev/null 2>&1
}

if command -v bun >/dev/null 2>&1; then
  info "Found bun — using it."
elif node_runs_ts; then
  info "Found a TypeScript-capable node — using it."
else
  info "No bun (or TS-capable node) found — installing bun from https://bun.sh ..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 \
    || die "bun install failed. Install bun (https://bun.sh) or Node >= 23.6, then re-run."
  [ -x "${HOME}/.bun/bin/bun" ] || die "bun installed but not found at ~/.bun/bin/bun."
  info "bun installed to ~/.bun."
fi

# --- fetch the tool -----------------------------------------------------------
info "Downloading ${NAME} (${REF}) ..."
mkdir -p "$DATA_DIR"
curl -fsSL "$SRC_URL" -o "${DATA_DIR}/${NAME}.ts" \
  || die "download failed: ${SRC_URL}"

# --- write a launcher that resolves a runtime at run time ---------------------
mkdir -p "$BIN_DIR"
cat > "$SHIM" <<EOF
#!/bin/sh
# launcher for ${NAME} — prefers bun, falls back to a TS-capable node
SCRIPT="${DATA_DIR}/${NAME}.ts"
if command -v bun >/dev/null 2>&1; then exec bun "\$SCRIPT" "\$@"; fi
if [ -x "\$HOME/.bun/bin/bun" ]; then exec "\$HOME/.bun/bin/bun" "\$SCRIPT" "\$@"; fi
if command -v node >/dev/null 2>&1; then exec node "\$SCRIPT" "\$@"; fi
echo "${NAME}: needs bun (https://bun.sh) or Node >= 23.6 on PATH" >&2
exit 1
EOF
chmod +x "$SHIM"

info "Installed:"
printf '      script   %s\n' "${DATA_DIR}/${NAME}.ts"
printf '      command  %s\n' "$SHIM"

# --- PATH hint ----------------------------------------------------------------
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    warn "${BIN_DIR} is not on your PATH. Add it, then reopen your terminal:"
    printf '      echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc\n' "$BIN_DIR"
    ;;
esac

info "Done. Run:  ${NAME}"
info "(dry-run by default — nothing changes without --apply)"

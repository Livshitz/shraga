[ -r "${HOME}/.zlogin" ] && source "${HOME}/.zlogin"
# Login shells read .zlogin AFTER .zshrc — re-prepend again so the shim stays first for login panes too.
[ -n "$UNCLAW_BIN_DIR" ] && export PATH="$UNCLAW_BIN_DIR:$PATH"

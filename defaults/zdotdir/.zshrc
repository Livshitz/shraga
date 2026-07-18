[ -r "${HOME}/.zshrc" ] && source "${HOME}/.zshrc"
# Re-prepend AFTER the user's rc so our `claude` shim (session-id capture for revive) wins on PATH.
[ -n "$UNCLAW_BIN_DIR" ] && export PATH="$UNCLAW_BIN_DIR:$PATH"

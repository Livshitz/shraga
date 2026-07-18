# shraga pane ZDOTDIR wrapper — loads the user's real zsh config, then (in .zshrc/.zlogin) re-prepends
# our bin dir so the `claude` shim wins over the real claude regardless of how the user's rc reorders
# PATH. Only shraga-spawned panes get ZDOTDIR set, so the user's own shells are untouched.
[ -r "${HOME}/.zshenv" ] && source "${HOME}/.zshenv"

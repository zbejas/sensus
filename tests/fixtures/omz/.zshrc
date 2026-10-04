# oh-my-zsh realism fixture (see probe-shell.sh).
#
# ZDOTDIR points at this committed directory, so keep zsh from dropping its
# generated completion dumps / history INTO the fixture: redirect them to a
# throwaway temp path. (oh-my-zsh honours ZSH_COMPDUMP; zsh honours HISTFILE.)
ZSH_COMPDUMP="${TMPDIR:-/tmp}/sensus-omz-zcompdump-$$"
HISTFILE="${TMPDIR:-/tmp}/sensus-omz-history-$$"

# Source the user's real oh-my-zsh ONLY when present, then print a labeled SGR
# probe and drop back to the interactive prompt so the pane stays alive. The
# smoke test asserts the painted SGR, not the shell. (ZSH_THEME must be set
# BEFORE sourcing — oh-my-zsh reads it while loading the theme.)
if [[ -f "$HOME/.oh-my-zsh/oh-my-zsh.sh" ]]; then
  ZSH_THEME=robbyrussell
  source "$HOME/.oh-my-zsh/oh-my-zsh.sh"
fi

printf 'P31:\033[31mR\033[0m P256:\033[38;5;1mR\033[0m PBOLD:\033[1;31mR\033[0m PTC:\033[38;2;191;97;106mR\033[0m PBRIGHT:\033[91mR\033[0m\n'

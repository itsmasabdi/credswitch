import { bindingsListPath } from "./paths.js";

/**
 * Shell hooks keep `cd` fast: a pure-shell ancestor check against a plain-text
 * list of bound directories, and the csw binary only runs on transitions
 * (entering a bound tree, moving between bound trees, or leaving one).
 * Shells pinned with `csw shell` (AGENTCTX_OVERRIDE=1) are left alone.
 */

export function zshHook(): string {
  const list = bindingsListPath();
  return `# agentctx — automatic per-folder context switching (zsh)
# Install: echo 'eval "$(csw hook zsh)"' >> ~/.zshrc
_agentctx_chpwd() {
  [[ -n "$AGENTCTX_OVERRIDE" ]] && return
  local list=${JSON.stringify(list)}
  local -a _agentctx_dirs
  local dir="$PWD" hit=""
  [[ -r "$list" ]] && _agentctx_dirs=("\${(@f)$(<"$list")}")
  while :; do
    if (( \${_agentctx_dirs[(Ie)$dir]} )); then hit="$dir"; break; fi
    [[ "$dir" == "/" ]] && break
    dir="\${dir:h}"
  done
  if [[ -n "$hit" ]]; then
    [[ "$hit" == "$AGENTCTX_BOUND_DIR" ]] && return
    eval "$(command csw env --dir "$hit" 2>/dev/null)"
  elif [[ -n "$AGENTCTX_BOUND_DIR" ]]; then
    eval "$(command csw env --clear 2>/dev/null)"
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _agentctx_chpwd
_agentctx_chpwd
`;
}

export function bashHook(): string {
  const list = bindingsListPath();
  return `# agentctx — automatic per-folder context switching (bash)
# Install: echo 'eval "$(csw hook bash)"' >> ~/.bashrc
_agentctx_prompt() {
  [[ -n "$AGENTCTX_OVERRIDE" ]] && return
  local list=${JSON.stringify(list)}
  local dir="$PWD" hit=""
  if [[ -r "$list" ]]; then
    while :; do
      if grep -qxF "$dir" "$list" 2>/dev/null; then hit="$dir"; break; fi
      [[ "$dir" == "/" ]] && break
      dir="$(dirname "$dir")"
    done
  fi
  if [[ -n "$hit" ]]; then
    [[ "$hit" == "$AGENTCTX_BOUND_DIR" ]] && return
    eval "$(command csw env --dir "$hit" 2>/dev/null)"
  elif [[ -n "$AGENTCTX_BOUND_DIR" ]]; then
    eval "$(command csw env --clear 2>/dev/null)"
  fi
}
if [[ -z "$_AGENTCTX_HOOKED" ]]; then
  _AGENTCTX_HOOKED=1
  PROMPT_COMMAND="_agentctx_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
_agentctx_prompt
`;
}

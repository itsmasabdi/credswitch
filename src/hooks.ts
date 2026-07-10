import { allManagedVars } from "./env.js";
import { bindingsListPath } from "./paths.js";
import { shellQuote } from "./util.js";

/**
 * Shell hooks keep `cd` fast with a pure-shell fast path: parse the
 * "dir<TAB>context" bindings list, find the nearest bound ancestor of the
 * canonical $PWD, and only invoke csw when the applied state would change.
 * All actual resolution happens in `csw env --cwd` (the real resolver), so the
 * hook can never disagree with `csw current`. If csw fails, the hook clears
 * every managed variable and warns — fail closed, never stale.
 * Shells pinned with `csw shell` (AGENTCTX_OVERRIDE=1) are left alone.
 */

function fallbackClear(): string {
  const vars = [...allManagedVars(), "AGENTCTX_CONTEXT", "AGENTCTX_BOUND_DIR", "AGENTCTX_HOOK_KEY"];
  return `unset ${vars.join(" ")}`;
}

export function zshHook(): string {
  const list = shellQuote(bindingsListPath());
  return `# agentctx — automatic per-folder context switching (zsh)
# Install: echo 'eval "$(csw hook zsh)"' >> ~/.zshrc
_agentctx_hook() {
  [[ -n "$AGENTCTX_OVERRIDE" ]] && return
  local list=${list}
  local pwdreal="\${PWD:A}" hit="" hitctx="" dir ctx key out
  if [[ -r "$list" ]]; then
    while IFS=$'\\t' read -r dir ctx; do
      [[ -z "$dir" ]] && continue
      if [[ "$pwdreal" == "$dir" || "$pwdreal" == "$dir"/* ]]; then
        (( \${#dir} > \${#hit} )) && { hit="$dir"; hitctx="$ctx"; }
      fi
    done < "$list"
  fi
  if [[ -n "$hit" ]]; then key="b:$hit:$hitctx"; else key="d"; fi
  [[ "$key" == "$AGENTCTX_HOOK_KEY" ]] && return
  if out="$(command csw env --cwd "$pwdreal" 2>/dev/null)"; then
    eval "$out"
    export AGENTCTX_HOOK_KEY="$key"
  else
    eval ${shellQuote(fallbackClear())}
    print -u2 "agentctx: could not resolve a context for $pwdreal — cleared managed credentials (run 'csw doctor')"
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _agentctx_hook
_agentctx_hook
`;
}

export function bashHook(): string {
  const list = shellQuote(bindingsListPath());
  return `# agentctx — automatic per-folder context switching (bash)
# Install: echo 'eval "$(csw hook bash)"' >> ~/.bashrc
_agentctx_hook() {
  [[ -n "$AGENTCTX_OVERRIDE" ]] && return
  local list=${list}
  local pwdreal hit="" hitctx="" dir ctx key out
  pwdreal="$(pwd -P)"
  if [[ -r "$list" ]]; then
    while IFS=$'\\t' read -r dir ctx; do
      [[ -z "$dir" ]] && continue
      if [[ "$pwdreal" == "$dir" || "$pwdreal" == "$dir"/* ]]; then
        (( \${#dir} > \${#hit} )) && { hit="$dir"; hitctx="$ctx"; }
      fi
    done < "$list"
  fi
  if [[ -n "$hit" ]]; then key="b:$hit:$hitctx"; else key="d"; fi
  [[ "$key" == "$AGENTCTX_HOOK_KEY" ]] && return
  if out="$(command csw env --cwd "$pwdreal" 2>/dev/null)"; then
    eval "$out"
    export AGENTCTX_HOOK_KEY="$key"
  else
    eval ${shellQuote(fallbackClear())}
    echo "agentctx: could not resolve a context for $pwdreal — cleared managed credentials (run 'csw doctor')" >&2
  fi
}
if [[ -z "$_AGENTCTX_HOOKED" ]]; then
  _AGENTCTX_HOOKED=1
  PROMPT_COMMAND="_agentctx_hook\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
_agentctx_hook
`;
}

import { adapters } from "./adapters.js";
import { bindingsListPath, deniedRoot } from "./paths.js";
import { shellQuote } from "./util.js";

/**
 * Shell hooks run before every prompt (like direnv), so `csw login` and
 * `csw local` take effect at the next prompt in the SAME shell — no cd
 * dance. The pure-shell fast path parses the "dir<TAB>context" bindings
 * list (plus a #gen stamp that changes on every config save) and only
 * invokes csw when the applied state would change. All actual resolution
 * happens in `csw env --cwd` (the real resolver), so the hook can never
 * disagree with `csw current`. If csw fails, the hook clears every managed
 * variable and warns — fail closed, never stale.
 * Shells pinned with `csw shell` (CREDSWITCH_OVERRIDE=1) are left alone.
 */

/**
 * When `csw env` itself fails, fail CLOSED: point every selector at the
 * read-only denied root (machine defaults stay unreachable) and clear the
 * token channels. Unsetting alone would fail open.
 */
function fallbackDeny(): string {
  const root = deniedRoot();
  const exports: string[] = [];
  const unsets = new Set<string>(["CREDSWITCH_CONTEXT", "CREDSWITCH_BOUND_DIR", "CREDSWITCH_HOOK_KEY"]);
  for (const adapter of Object.values(adapters)) {
    const denied = adapter.deniedEnv(root);
    for (const [key, value] of Object.entries(denied)) exports.push(`export ${key}=${shellQuote(value)}`);
    for (const key of adapter.managedEnv) {
      if (!(key in denied)) unsets.add(key);
    }
  }
  return [...exports.sort(), `unset ${[...unsets].sort().join(" ")}`].join("; ");
}

export function zshHook(): string {
  const list = shellQuote(bindingsListPath());
  return `# credswitch — automatic per-folder identity switching (zsh)
# Install: csw setup   (or: echo 'eval "$(csw hook zsh)"' >> ~/.zshrc)
_credswitch_hook() {
  [[ -n "$CREDSWITCH_OVERRIDE" ]] && return
  local list=${list}
  local pwdreal="\${PWD:A}" hit="" hitctx="" gen="" dir ctx key out
  if [[ -r "$list" ]]; then
    while IFS=$'\\t' read -r dir ctx; do
      [[ -z "$dir" ]] && continue
      if [[ "$dir" == "#gen" ]]; then gen="$ctx"; continue; fi
      [[ "$dir" == \\#* ]] && continue
      if [[ "$pwdreal" == "$dir" || "$pwdreal" == "$dir"/* ]]; then
        (( \${#dir} > \${#hit} )) && { hit="$dir"; hitctx="$ctx"; }
      fi
    done < "$list"
  fi
  if [[ -n "$hit" ]]; then key="$gen|b:$hit:$hitctx"; else key="$gen|d"; fi
  [[ "$key" == "$CREDSWITCH_HOOK_KEY" ]] && return
  if out="$(command csw env --cwd "$pwdreal" 2>/dev/null)"; then
    eval "$out"
  else
    eval ${shellQuote(fallbackDeny())}
    print -u2 "credswitch: could not resolve a context for $pwdreal — denied all providers (run 'csw doctor')"
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _credswitch_hook
_credswitch_hook
`;
}

export function bashHook(): string {
  const list = shellQuote(bindingsListPath());
  return `# credswitch — automatic per-folder identity switching (bash)
# Install: csw setup --shell bash   (or: echo 'eval "$(csw hook bash)"' >> ~/.bashrc)
_credswitch_hook() {
  [[ -n "$CREDSWITCH_OVERRIDE" ]] && return
  local list=${list}
  local pwdreal hit="" hitctx="" gen="" dir ctx key out
  pwdreal="$(pwd -P)"
  if [[ -r "$list" ]]; then
    while IFS=$'\\t' read -r dir ctx; do
      [[ -z "$dir" ]] && continue
      if [[ "$dir" == "#gen" ]]; then gen="$ctx"; continue; fi
      [[ "$dir" == \\#* ]] && continue
      if [[ "$pwdreal" == "$dir" || "$pwdreal" == "$dir"/* ]]; then
        (( \${#dir} > \${#hit} )) && { hit="$dir"; hitctx="$ctx"; }
      fi
    done < "$list"
  fi
  if [[ -n "$hit" ]]; then key="$gen|b:$hit:$hitctx"; else key="$gen|d"; fi
  [[ "$key" == "$CREDSWITCH_HOOK_KEY" ]] && return
  if out="$(command csw env --cwd "$pwdreal" 2>/dev/null)"; then
    eval "$out"
  else
    eval ${shellQuote(fallbackDeny())}
    echo "credswitch: could not resolve a context for $pwdreal — denied all providers (run 'csw doctor')" >&2
  fi
}
if [[ -z "$_CREDSWITCH_HOOKED" ]]; then
  _CREDSWITCH_HOOKED=1
  PROMPT_COMMAND="_credswitch_hook\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
_credswitch_hook
`;
}

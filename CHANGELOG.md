# Changelog

## 0.3.1 — 2026-07-10

Safety patch on the porcelain, from a pre-promotion review.

- **`csw login` is now fully transactional**: context creation, binding,
  default, account, and slot swap commit in ONE config write *after* login
  and verification succeed. A cancelled login leaves no context, no binding,
  no account — "Nothing was saved" is now literally true.
- **"This folder" means this folder**: `csw login` only reuses a context
  whose binding is the current directory itself. Under an ancestor's binding
  (or just the global default) it creates a local override context — seeded
  with everything that already applied there, with only the one adapter slot
  swapped — instead of silently mutating a context shared with sibling
  folders.
- **Hook failure now fails closed**: if `csw env` errors, the fallback points
  every selector at the read-only denied root (unsetting alone would have
  re-enabled machine defaults) and clears token channels.
- **Credential-channel inventory extended** (confirmed against provider
  docs): claude `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`; github `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN`; gcloud `CLOUDSDK_AUTH_ACCESS_TOKEN`.
- **Hook-cache race fixed**: the config carries a generation counter and
  `csw env` stamps `CREDSWITCH_HOOK_KEY` with the generation of the config it
  actually read, so a shell that catches the bindings list mid-write simply
  re-asks at the next prompt instead of caching stale state.

## 0.3.0 — 2026-07-10

The pyenv moment: a porcelain layer so the everyday workflow is two commands.

- **`csw setup`** — one-time: creates the config and installs the shell hook
  into your rc file (idempotent).
- **`csw login <adapter>`** — gives the *current folder* its own identity in
  one command: infers or creates the context (named after the folder), binds
  the folder, creates isolated account state, runs the provider's real login,
  pins the verified identity, and swaps it into the context's adapter slot.
  `--as <name>` reuses/creates a specific account; `--global` targets the
  machine-wide default context (creating it if needed). Warns when the fresh
  login has the same identity as another account of that adapter (the
  "logged into the wrong account" accident). Refuses to implicitly bind `$HOME`
  or `/`.
- **`csw local [<context>]`** — bind the current folder to a named context
  (created if missing); with no argument, shows what applies here.
- **Hook now runs per prompt** (like direnv) instead of per `cd`, with a config
  generation stamp: `csw login`, `csw local`, and account swaps take effect at
  the next prompt in every open shell — no cd dance, no restart.
- Help and README restructured around Everyday vs Plumbing. All existing
  commands unchanged.

Security model unchanged: switching is automatic everywhere, but a folder only
ever *gains* an identity through an explicit `csw login`/`csw local` you run
inside it — never from anything a repository ships.

## 0.2.1 — 2026-07-10

Docs-only: README badges, sanitized examples, SECURITY.md and CHANGELOG
added to the repo. No code changes.

## 0.2.0 — 2026-07-10

First public release, published as `credswitch`.

- **Fail-closed contexts**: adapters a context omits are *denied* — their
  selectors point into a read-only denied root, so their CLIs report
  not-logged-in and can never persist credentials there. `--system` is the
  explicit machine-default opt-in, available on every adapter.
- **Full credential-channel inventory**: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `GH_TOKEN`/`GITHUB_TOKEN`/`GH_HOST`, and `AZURE_CLIENT_*` are managed
  (cleared) alongside the config-dir selectors.
- **Resolver-backed shell hook** (`csw env --cwd`): applies the default
  context outside bound trees, canonicalizes `$PWD`, detects rebinds, and
  clears loudly on failure instead of retaining stale credentials.
- **Identity pinning**: `account add`/`account login` pin the verified
  identity; `csw doctor` fails on drift; `csw account pin` accepts changes
  deliberately.
- **Transactional onboarding**: login + verification before anything is
  saved; a failed or cancelled login saves nothing and removes its fresh
  state dir; account names validated before any filesystem use; referenced
  paths stored canonically; non-empty fresh dirs refused.
- **Concurrency safety**: config mutations take a lock; the hook's bindings
  list is written before the config so crash skew fails safe.
- Resolution precedence gains an `inherited` level (`CREDSWITCH_CONTEXT`)
  so nested agent runs keep their parent's context.
- Commands: `account login`, `account pin`, `context set`; real signal exit
  codes from `csw run`.

Adapters: azure, gcloud, github, claude, codex, kubernetes.

## 0.1.0 — 2026-07-10 (unpublished; git history only)

Initial four-primitive core (adapters / accounts / contexts / bindings),
single resolver, env clearing, zsh/bash hooks, fake-provider test suite.

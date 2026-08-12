# Changelog

## 0.5.0 — 2026-08-12

- **`--json` on `current`, `list`, `doctor`, and `account list`.** An agent can
  now check which identity it is holding without parsing prose. `doctor --json`
  keeps its exit code (2 on drift or breakage) and writes nothing but the
  report to stdout, so it works as a CI gate.
- **`doctor` probes each account once, concurrently.** It previously re-ran the
  live identity check for every (context, account) pair, serially, with a 30s
  timeout each — an account shared by five contexts was five network round
  trips. Identity checks are now async and deduplicated by account id.
- Adapters that isolate through a single directory variable (azure, gcloud,
  github, claude, codex) are declared through one `singleDirAdapter` factory
  instead of repeating the same five fields. Adding a provider of that shape is
  now a table entry; the isolate/deny/create-state invariant is defined once.
- `commands.ts` (1,077 lines) split into `src/commands/` by area — account,
  context, binding, session, doctor, porcelain — with the shared helpers in one
  place. No file is over 350 lines now.

## 0.4.2 — 2026-08-12

Safety patch. Both fixes are silent-wrong-identity or total-denial failures in
the agent path, found by review.

- **A `csw run` context now survives into the shells an agent spawns.**
  `csw run -c acme -- claude` exports the context, but any subprocess that
  sources your rc file runs the hook, which re-resolved from the working
  directory alone and dropped back to the global default — so the agent ran as
  the wrong identity, silently. The hook now forwards the inherited floor
  (`CREDSWITCH_INHERIT`, internal plumbing alongside `CREDSWITCH_HOOK_KEY`) to
  `csw env`, restoring the documented precedence: a folder binding still wins,
  but the run context beats the default. Bindings deliberately keep winning, so
  an agent that enters another client's folder picks up that client's identity
  instead of carrying the launch context's credentials into it.
- **An unwritable Codex profile no longer denies every provider in every
  shell.** The bundled-marketplace self-heal ran inside context resolution and
  threw on failure; the hook reads any non-zero exit as "resolution failed" and
  denies all seven adapters, every prompt, with the real error swallowed. The
  repair no longer throws, and no longer runs during resolution at all —
  `setup`, `doctor`, and `login` own it, and `doctor` reports failures. The
  hook path is now side-effect free.
- `cliInstalled` resolves PATH directly instead of shelling out to `which`,
  which Debian 13 dropped from debianutils — every adapter reported "not
  installed" there. Also removes several subprocesses per `doctor`/`login`.
- `redactHome` matches on a path boundary: `/Users/you-backup` rendered as
  `~-backup`.
- Removed tolerance for configs predating the `gen` counter, and the unused
  `description` field on accounts.

## 0.4.1 — 2026-08-11

- `csw --help` reported 0.3.2 on the 0.4.0 release: the version was hardcoded
  in `cli.ts` as well as `package.json`, and only the manifest was bumped. The
  CLI now reads its version from the manifest, and a test asserts the two
  agree, so the copies can no longer drift.

## 0.4.0 — 2026-08-11

- **New `aws` adapter.** AWS has no single config-directory variable, so the
  adapter redirects all three writable channels the CLI owns: `AWS_CONFIG_FILE`,
  `AWS_SHARED_CREDENTIALS_FILE`, and the `aws login` cache
  (`AWS_LOGIN_CACHE_DIRECTORY`). Static keys, session tokens, profile selectors,
  assumed-role variables, and the container credential sources are all cleared,
  so nothing leaks in from the calling shell.
- `csw login aws` picks the re-auth flow from the account's own config:
  `aws sso login` for an IAM Identity Center profile, `aws login` otherwise.
  Identity is verified and pinned with `aws sts get-caller-identity`.
- Denying `aws` also sets `AWS_EC2_METADATA_DISABLED`, so a denied context on an
  EC2 host cannot fall through to the instance role.
- `AWS_REGION`/`AWS_DEFAULT_REGION` are deliberately unmanaged. Known limit: the
  Identity Center token cache (`~/.aws/sso/cache`) has no environment override
  and stays machine-wide — keyed by session, so accounts do not collide.
- New optional `prepareStateDir` adapter hook, used by `aws` to create the login
  cache directory the CLI expects to already exist.
- Isolated Codex profiles now self-heal a stale app-owned
  `openai-bundled` marketplace source whenever the profile is activated. This
  prevents alternate `CODEX_HOME` accounts from retaining Browser/Chrome
  plugin builds from another profile after a ChatGPT app update.
- `csw setup` repairs all configured Codex accounts and `csw doctor` reports
  marketplace alignment or repair. The targeted edit preserves credentials,
  other marketplaces, plugin selections, file mode, comments, and surrounding
  TOML; ambiguous or non-local sources are left unchanged and diagnosed.

## 0.3.2 — 2026-07-13

- **Shell startup now fails closed when `csw` is missing**: hooks installed by
  `csw setup` point every provider at the denied state root and clear managed
  token variables if the executable is unavailable (for example after a Node
  version change), instead of falling back to machine-default credentials.
- Corrected stale pre-rename metadata in `package-lock.json`.

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

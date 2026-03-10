# clawctl Spec

## Purpose

`clawctl` is a claw runtime manager.

It installs supported claw implementations under a shared root, keeps one active claw selection, renders per-claw runtime config from shared credentials, and exposes a small CLI for install, selection, managed runtime lifecycle, health checks, and chat.

The product shape is closer to `nvm` or `mise` than to the original benchmark harness.

## Current Status

This spec reflects the codebase as currently implemented.

Implemented today:

- Effect-native Bun CLI built on `@effect/cli`
- shared install root under `~/.clawctl` by default, with `CLAWCTL_ROOT` / `CLAWCTL_STATE_DIR` overrides
- local and Docker backend execution for the supported adapters
- adapter registry with Tier 1, Tier 2, and Tier 3 entries
- immutable install records plus isolated runtime directories
- shared config file plus active-selection file
- active shims under `~/.clawctl/bin/`
- install, uninstall, use, current, cleanup, init, list, versions, doctor, status, ping, chat, stop, and config commands
- custom metadata-driven help output for root commands and subcommands
- managed native-daemon and proxy-daemon runtime flows where the adapter supports them

Modeled but not implemented yet:

- `source-build` install strategy
- broader host-platform support

## Goals

- Install multiple claw implementations and versions under one root.
- Keep a single active claw selection.
- Share a small credential/config surface across supported claws.
- Render native per-claw config into isolated runtime directories.
- Support managed local runtime `chat`, `ping`, `status`, and `stop` flows where the adapter allows it.
- Support managed Docker runtime `chat`, `ping`, `status`, and `stop` flows where the adapter allows it.

## Non-Goals

- No cross-claw session portability.
- No universal abstraction for all claw-specific features.
- No guarantee that every registered claw supports `use`, `chat`, or `ping`.
- No Telegram transport ownership in `clawctl` today.

## Platform Support

Current supported host platform:

- `darwin-arm64`

The installer and runtime paths currently enforce this for both supported backends.

## Technical Direction

`clawctl` is implemented as an Effect-native Bun CLI.

Current implementation choices:

- `@effect/cli` for the command tree
- `@effect/platform-bun` for runtime integration
- Effect services for paths, store, installer, runtime, and maintenance
- `FileSystem`, `CommandExecutor`, `HttpClient`, `Terminal`, and `Path` on the live path
- typed user/system errors through tagged Effect errors

The live CLI path no longer uses the removed Promise-era helper modules.

## Command Surface

Current commands:

```bash
clawctl install [--runtime local|docker] <target>
clawctl uninstall [--all] [--runtime local|docker] <target>
clawctl use [--runtime local|docker] <target>
clawctl current
clawctl cleanup [<target>]
clawctl init [<shell>]
clawctl list [--installed]
clawctl versions <target>
clawctl doctor [<target>]
clawctl status [<target>]
clawctl ping [<target>]
clawctl chat <message> [<target>]
clawctl stop [--runtime local|docker] [<target>]
clawctl config get <key>
clawctl config set <key> <value>
```

Notes on current behavior:

- `target` means `<implementation>` or `<implementation>@<version>`.
- running `clawctl`, `clawctl --help`, or `clawctl <command> --help` prints custom metadata-driven help instead of the raw `@effect/cli` help output.
- `config` without a subcommand prints a short usage hint.
- `chat`, `ping`, and `status` default to the active claw when no target is provided.
- `list --installed` prints only installed versions; plain `list` prints one line per registered implementation with either installed versions or `not installed`.
- `versions` lists remote or adapter-defined installable versions and rejects version-qualified targets.
- `init` appends PATH setup for `bash`, `zsh`, or `fish` if the line is not already present.
- `use` auto-installs the target if it is missing locally.
- `cleanup` and `doctor` accept implementation targets, but `cleanup` rejects version-qualified targets.
- `use` auto-installs missing targets, stops the previous managed runtime, starts the new one when the adapter is interactable, and then updates `current.json`.
- `chat` and `ping` auto-activate the selected record before running.
- `status` reports live runtime state, including managed runtime PID and port when available.
- `stop` terminates the managed runtime for the selected or active claw on the chosen backend.

## Shared Root Layout

Default root:

```text
~/.clawctl/
```

Current layout:

```text
~/.clawctl/
  bin/
    claw
    <implementation>
  cache/
    downloads/
      <implementation>/
        <version>/
  config/
    current.json
    shared.env
  installs/
    local/
      <implementation>/
        <version>/
          install.json
          ...
    docker/
      <implementation>/
        <version>/
          install.json
          docker-image.txt
  logs/
  runtimes/
    local/
      <implementation>/
        <version>/
          runtime.json
          service.log
          home/
          state/
          workspace/
    docker/
      <implementation>/
        <version>/
          runtime.json
          service.log
          home/
          state/
          workspace/
```

Rules:

- `installs/` is treated as immutable installed artifact state.
- `runtimes/` is mutable, per-version runtime state.
- `config/current.json` stores the active implementation, version, and backend.
- `config/shared.env` stores the shared config source of truth.
- `bin/claw` and `bin/<implementation>` are rewritten active shims that route back through `clawctl`.
- adapter-rendered native config lives under the runtime `home/` subtree.
- managed runtime metadata lives under the runtime root and includes runtime state, PID, port, and log output.
- the top-level `logs/` directory is currently provisioned but per-runtime logs live under `runtimes/.../service.log`.

## Shared Configuration

Current shared config keys:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_ALLOWED_FROM`

Current defaults:

- `CLAW_BASE_URL=https://openrouter.ai/api/v1`
- `CLAW_MODEL=moonshotai/kimi-k2.5`
- `CLAW_API_KEY=replace-me`

Implementation notes:

- config is loaded through Effect `Config`
- secret values are represented as `Redacted` in memory
- most current adapters require only `CLAW_API_KEY`, `CLAW_BASE_URL`, and `CLAW_MODEL`
- supported adapters can also render or export Telegram settings from the shared config
- `use` rewrites active shims under `~/.clawctl/bin/`

## Runtime Model

Current runtime support includes managed local daemons and managed Docker containers.

For interactable local adapters:

- `nullclaw`, `picoclaw`, `zeroclaw`, `openclaw`, `nanobot`, and `hermes` support activation through `use`
- `use` stops the previous managed runtime, renders config into `runtimes/<backend>/<impl>/<version>/home`, rewrites active shims, updates `current.json`, and starts the selected runtime when needed
- runtimes run either as native supervised daemons or through a clawctl-managed proxy daemon, depending on the adapter
- `chat`, `ping`, and `status` target the selected or active runtime path for that adapter

For interactable Docker adapters:

- the same supported adapter set can be installed and activated with `--runtime docker`
- Docker runtimes are supervised as named containers under the selected implementation/version/backend
- `chat` and `ping` execute inside the active container through `docker exec`
- runtime config still renders into `runtimes/docker/<impl>/<version>/home`

## Adapter Model

The adapter schema supports:

- support tiers
- platform selectors
- `local` and `docker` backend descriptors
- install strategies
- runtime metadata
- config templates
- capability flags

Current install strategies in the schema:

- `github-release`
- `npm-package`
- `python-package`
- `repo-bootstrap`
- `docker-build`
- `source-build`

Current live installer support:

- `github-release`
- `npm-package`
- `python-package` with `uv-tool`
- `repo-bootstrap`

Not implemented on the live installer path:

- `docker-build`
- `source-build`
- `python-package` installers other than `uv-tool`

Each adapter currently supplies implementation hooks for:

- building the proxied chat command
- rendering config files
- computing runtime environment variables
- optionally normalizing chat output

## Support Tiers

Current registry entries are grouped as follows.

Tier 1:

- `nullclaw`
- `picoclaw`
- `zeroclaw`

These are release-backed local adapters and are fully exercised by the current managed-runtime CLI flow.

Tier 2:

- `openclaw`
- `nanobot`

These are package-managed local adapters and are also supported by the current managed-runtime CLI flow.

Tier 3:

- `hermes`

Current Tier 3 behavior:

- `hermes` is installable through `repo-bootstrap` and supports managed local `use`, `status`, `stop`, `chat`, and `ping`

## Install and Version Behavior

Current version policy:

- explicit `@version` is supported
- otherwise the installer resolves the latest upstream version for supported package/release adapters
- `repo-bootstrap` adapters default to their static configured version, currently `main`

Install metadata persisted per installed version:

- implementation id
- requested version
- resolved version
- backend
- install strategy
- install root
- entrypoint command
- platform
- source reference
- verification summary
- install timestamp
- support tier

## Doctor and Cleanup

`doctor` currently verifies:

- registry validity
- shim PATH setup and active shim presence when relevant
- backend platform compatibility for the host
- required host tools for each install strategy
- required shared config keys
- installed entrypoint presence where applicable

`cleanup` currently removes:

- stale partial install directories
- orphaned runtime directories
- stale `current.json` selections that reference no installed record

## Current Gaps

The main gaps between the adapter model and shipped behavior are:

- `source-build` is modeled but not executed by the live installer
- non-`uv-tool` Python installer modes are modeled but not executed by the live installer
- Telegram-related shared config is rendered for supported adapters, but `clawctl` does not own or proxy Telegram transport itself
- no first-class support beyond `darwin-arm64`

## Source of Truth

When this document and the code diverge, the current implementation in `packages/cli/src/` is the source of truth.

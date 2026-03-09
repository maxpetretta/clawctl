# clawctl Spec

## Purpose

`clawctl` is a local claw runtime manager.

It installs supported claw implementations under a shared root, keeps one active claw selection, renders per-claw runtime config from shared credentials, and exposes a small pass-through CLI for install, selection, managed local runtime lifecycle, health checks, and chat.

The product shape is closer to `nvm` or `mise` than to the original benchmark harness.

## Current Status

This spec reflects the codebase as currently implemented.

Implemented today:

- Effect-native Bun CLI built on `@effect/cli`
- shared install root under `~/.clawctl` by default
- local backend only
- adapter registry with Tier 1, Tier 2, and Tier 3 entries
- immutable install records plus isolated runtime directories
- shared config file plus active-selection file
- install, uninstall, list, use, current, doctor, cleanup, status, ping, chat, stop, and config commands

Modeled but not implemented yet:

- Docker runtime backend
- Telegram-driven runtime ownership
- richer help text and examples

## Goals

- Install multiple claw implementations and versions under one root.
- Keep a single active claw selection.
- Share a small credential/config surface across supported claws.
- Render native per-claw config into isolated runtime directories.
- Support managed local runtime `chat`, `ping`, `status`, and `stop` flows where the adapter allows it.
- Keep the adapter model broad enough to add Docker later.

## Non-Goals

- No cross-claw session portability.
- No universal abstraction for all claw-specific features.
- No guarantee that every registered claw supports `use`, `chat`, or `ping`.
- No Docker execution path in the current implementation.
- No Telegram transport ownership in `clawctl` today.

## Platform Support

Current supported host platform:

- `darwin-arm64`

The installer and runtime paths enforce this for the local backend.

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
clawctl list [--installed]
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
- `chat`, `ping`, and `status` default to the active claw when no target is provided.
- `use` auto-installs the target if it is missing locally.
- `chat` and `ping` activate the selected record before running.
- `cleanup` and `doctor` accept implementation targets, but `cleanup` rejects version-qualified targets.
- `use` auto-installs missing targets, stops the previous managed runtime, starts the new one, and then updates `current.json`.
- `chat` and `ping` auto-activate the selected record before running.
- `status` reports live runtime state, including managed runtime PID and port when available.
- `stop` terminates the managed local runtime for the selected or active claw.
- `--runtime docker` is parsed but rejected by service logic because Docker is not implemented yet.

## Shared Root Layout

Default root:

```text
~/.clawctl/
```

Current layout:

```text
~/.clawctl/
  config/
    current.json
    shared.env
  cache/
    downloads/
      <implementation>/
        <version>/
  installs/
    local/
      <implementation>/
        <version>/
          install.json
          ...
  logs/
  runtimes/
    local/
      <implementation>/
        <version>/
          home/
          state/
          workspace/
```

Rules:

- `installs/` is treated as immutable installed artifact state.
- `runtimes/` is mutable, per-version runtime state.
- `config/current.json` stores the active implementation, version, and backend.
- `config/shared.env` stores the shared config source of truth.
- adapter-rendered native config lives under the runtime `home/` subtree.
- managed runtime metadata lives under the runtime root and includes runtime state, PID, and port.

## Shared Configuration

Current shared config keys:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`

Current defaults:

- `CLAW_BASE_URL=https://openrouter.ai/api/v1`
- `CLAW_MODEL=moonshotai/kimi-k2.5`
- `CLAW_API_KEY=replace-me`

Implementation notes:

- config is loaded through Effect `Config`
- secret values are represented as `Redacted` in memory
- most current adapters require only `CLAW_API_KEY`, `CLAW_BASE_URL`, and `CLAW_MODEL`
- Telegram keys exist in shared config but are not yet used by the current local adapters

## Runtime Model

Current runtime model is local and managed by a clawctl-owned background process for activatable claws.

For claws that support activation:

- `use` stops the previous managed runtime, starts the selected one, and writes the active selection
- runtime config is rendered into `runtimes/local/<impl>/<version>/home`
- a clawctl-managed background process listens on localhost and proxies `chat`, `ping`, and health requests
- `chat` and `ping` go through that managed runtime instead of spawning directly from the foreground command

Current lifecycle limitations:

- Docker lifecycle is not implemented
- `ironclaw` is still install-only
- `piclaw` still requires a Docker backend
- supported release and bootstrap claws can now run under native daemon supervision

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
- other Python installer modes

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

- `nanoclaw`
- `bitclaw`
- `ironclaw`
- `piclaw`

Current Tier 3 behavior:

- `nanoclaw` and `bitclaw` are installable through `repo-bootstrap`
- `nanoclaw` supports `use`, `status`, and `stop` through native daemon supervision
- `nanoclaw` does not support `chat` or `ping` because upstream does not expose a stable local loopback or host-side chat transport
- `bitclaw` supports `use`, `status`, `stop`, `chat`, and `ping` through its host-side IPC transport
- `ironclaw` is installable through a release-backed local adapter
- `ironclaw` is not activatable through `use`
- `piclaw` is registered as Docker-first metadata only
- `doctor piclaw` works, but Docker execution is not implemented

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

- Docker backend is specified but not runnable
- help output is minimally customized
- no real daemon start/stop lifecycle
- no Telegram runtime integration yet
- no first-class support beyond `darwin-arm64`

## Source of Truth

When this document and the code diverge, the current implementation in `packages/cli/src/` is the source of truth.

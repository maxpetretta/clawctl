# clawctl Spec

## Purpose

`clawctl` is a local claw runtime manager.

It installs supported claw implementations under a shared root, keeps one active claw selection, renders per-claw runtime config from shared credentials, and exposes a small pass-through CLI for install, selection, health checks, and one-shot chat.

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
- resident daemon lifecycle beyond one-shot local chat
- Telegram-driven runtime ownership
- richer help text and examples

## Goals

- Install multiple claw implementations and versions under one root.
- Keep a single active claw selection.
- Share a small credential/config surface across supported claws.
- Render native per-claw config into isolated runtime directories.
- Support one-shot local `chat`, `ping`, and `status` flows where the adapter allows it.
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
- `stop` is currently a no-op message for the local one-shot backend.
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

Current runtime model is local and one-shot.

For claws that support activation:

- `use` writes the active selection
- runtime config is rendered into `runtimes/local/<impl>/<version>/home`
- `chat` and `ping` build a one-shot command and execute it in the runtime workspace

Current lifecycle limitations:

- there is no long-lived daemon supervisor
- `stop` does not terminate anything because the supported runtime path is one-shot
- `status` reports install metadata and adapter capabilities, not a real process state

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

- building the one-shot chat command
- rendering config files
- computing runtime environment variables
- optionally normalizing chat output

## Support Tiers

Current registry entries are grouped as follows.

Tier 1:

- `nullclaw`
- `picoclaw`
- `zeroclaw`

These are release-backed local one-shot adapters and are fully exercised by the current CLI flow.

Tier 2:

- `openclaw`
- `nanobot`

These are package-managed local one-shot adapters and are also supported by the current CLI flow.

Tier 3:

- `nanoclaw`
- `bitclaw`
- `piclaw`

Current Tier 3 behavior:

- `nanoclaw` and `bitclaw` are installable through `repo-bootstrap`
- they are not activatable through `use` because they do not advertise supported chat/daemon capabilities
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

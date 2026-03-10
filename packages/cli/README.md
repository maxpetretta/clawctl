# `@clawctl/cli`

`clawctl` is a runtime manager for supported claw implementations.

It installs versioned claws into a private root, keeps one active selection, renders isolated runtime config from shared credentials, starts a managed runtime for supported claws, and passes `chat`, `ping`, and `status` calls through that runtime.

## Current Scope

Current implementation status:

- host platform: `darwin-arm64`
- runtime backends: `local` and `docker`
- command runtime: Bun + Effect
- install root: `~/.clawctl` by default
- root and subcommand help are custom-rendered from shared metadata in a Docker-style layout

Supported today:

- Tier 1: `nullclaw`, `picoclaw`, `zeroclaw`
- Tier 2: `openclaw`, `nanobot`

Registered but limited:

- Tier 3: `hermes`
- `hermes` supports managed `install`, `use`, `status`, `stop`, `chat`, and `ping`

## Run The CLI

From the repo root:

```bash
bun run cli --help
```

Show the grouped root help directly:

```bash
bun run cli
```

From this package directly:

```bash
cd packages/cli
bun run start --help
```

Build a standalone binary:

```bash
cd packages/cli
bun run build
./dist/clawctl --help
```

## Common Operations

### 1. Inspect What Is Available

List all registered claws:

```bash
clawctl list
```

List only what is already installed locally:

```bash
clawctl list --installed
```

List installable remote versions for a claw:

```bash
clawctl versions openclaw
clawctl versions picoclaw
```

### 2. Configure Shared Credentials

Shared config is stored once and rendered into each isolated runtime as needed.

Set the common API values:

```bash
clawctl config set CLAW_API_KEY sk-...
clawctl config set CLAW_BASE_URL https://openrouter.ai/api/v1
clawctl config set CLAW_MODEL moonshotai/kimi-k2.5
```

Read a config value:

```bash
clawctl config get CLAW_MODEL
```

Current shared keys:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_ALLOWED_FROM`

To make the active claw CLI resolve on your shell, add:

```bash
export PATH="$HOME/.clawctl/bin:$PATH"
```

### 3. Install A Claw

Install the latest version:

```bash
clawctl install openclaw
```

Install an explicit version:

```bash
clawctl install openclaw@2026.3.7
clawctl install picoclaw@v0.2.0
```

Notes:

- installs are isolated under `~/.clawctl/installs/<backend>/<implementation>/<version>/`
- `openclaw` is installed into a private npm prefix managed by `clawctl`, not your global npm install
- `nanobot` is installed into a private `uv tool` directory managed by `clawctl`

### 4. Switch The Active Claw

Activate a specific installed version:

```bash
clawctl use openclaw@2026.3.7
```

Use the latest installed or auto-install if missing:

```bash
clawctl use openclaw
```

Show the current active selection:

```bash
clawctl current
```

`use` stops the previous managed runtime, renders isolated config for the new target, starts the new managed runtime in the background, updates `current.json`, and rewrites the active shims:

- `~/.clawctl/bin/claw`
- `~/.clawctl/bin/<active-implementation>`

Install-only adapters fail fast on `use` rather than pretending to support activation.

### 5. Talk To The Active Claw

Send a prompt to the current managed runtime:

```bash
clawctl chat "Summarize the current workspace."
```

Target a specific installed claw without changing shell state first:

```bash
clawctl chat "Reply with one sentence." openclaw@2026.3.7
```

Run the built-in ping check:

```bash
clawctl ping
```

Notes:

- `chat` and `ping` auto-activate the selected target before execution
- supported claws run behind a clawctl-managed runtime under `~/.clawctl/runtimes/<backend>/...`
- unsupported claws fail clearly instead of pretending to support chat

### 6. Initialize PATH Setup

Append clawctl shim setup for the current shell:

```bash
clawctl init
```

Or target a shell explicitly:

```bash
clawctl init zsh
clawctl init fish
```

### 7. Check Health And Runtime State

Run environment and install diagnostics:

```bash
clawctl doctor
clawctl doctor openclaw
```

Show install and adapter status:

```bash
clawctl status
clawctl status openclaw
```

Stop a managed runtime:

```bash
clawctl stop
clawctl stop openclaw
```

### 8. Remove Installs And Stale State

Remove one installed version:

```bash
clawctl uninstall openclaw@2026.3.7
```

Remove every installed version of a claw:

```bash
clawctl uninstall --all openclaw
```

Clean stale partial installs, orphaned runtimes, and invalid current selections:

```bash
clawctl cleanup
clawctl cleanup openclaw
```

## Filesystem Layout

By default, `clawctl` stores everything under:

```text
~/.clawctl/
  bin/
    claw
    <implementation>
  config/
    current.json
    shared.env
  cache/
  installs/
    local/
      <implementation>/
        <version>/
  runtimes/
    local/
      <implementation>/
        <version>/
          runtime.json
          service.log
          home/
          state/
          workspace/
```

High-level rules:

- `installs/` is immutable installed artifact state
- `runtimes/` is mutable runtime state
- shared credentials live only in `config/shared.env`
- each runtime gets its own isolated `HOME`, config files, state dir, workspace, runtime metadata, and service log

## Command Reference

```bash
clawctl install [--runtime local|docker] <target>
clawctl uninstall [--all] [--runtime local|docker] <target>
clawctl use [--runtime local|docker] <target>
clawctl current
clawctl cleanup [<target>]
clawctl init [<shell>]
clawctl list [--installed]
clawctl versions <implementation>
clawctl doctor [<target>]
clawctl status [<target>]
clawctl ping [<target>]
clawctl chat <message> [<target>]
clawctl stop [--runtime local|docker] [<target>]
clawctl config get <key>
clawctl config set <key> <value>
```

Current caveats:

- `source-build` is modeled but not implemented yet
- only `darwin-arm64` is supported right now

If you need the implementation-aligned product spec, see [`../../SPEC.md`](../../SPEC.md).

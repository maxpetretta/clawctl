# clawctl Spec

## Purpose

`clawctl` is a local claw runtime manager.

Its job is to let a user install multiple claw implementations and versions under one shared root, select one active claw at a time, share common credentials across implementations, and pass basic commands through to the active claw.

The product should feel closer to `mise`, `nvm`, or `pyenv` than to a benchmark harness.

## Goals

- Download and install supported claw implementations.
- Support multiple versions per implementation.
- Install everything under a single shared root directory.
- Let the user switch the active claw quickly.
- Share common credentials across claws.
- Provide basic `ping`, `chat`, and `status` commands.
- Start with `local` installs and execution.
- Design the runtime model so `docker` can be added later without changing the user-facing product shape.

## Non-Goals

- Do not require every claw to expose the same native transport.
- Do not normalize all claw-specific features into one universal API.
- Do not solve cross-claw state portability beyond shared config and workspace roots.
- Do not depend on Docker for the initial version.
- Do not make benchmark concerns the core architecture.

## Product Model

There are four core concepts:

1. `implementation`
   A claw family such as `openclaw`, `nanobot`, or `zeroclaw`.

2. `version`
   A specific installable release of an implementation.

3. `runtime backend`
   The environment used to run the claw, initially `local`, later `docker`.

4. `active runtime`
   The currently selected implementation + version + backend that receives pass-through commands.

The active runtime is analogous to the active Node version in `nvm`.

## User Outcomes

Users should be able to:

- install a claw version
- list installed claws and versions
- set one claw as active
- inspect the current active claw
- share API keys and Telegram credentials across claws
- run `chat`, `ping`, and `status` against the active claw
- optionally target a non-active claw explicitly

## Principles

- Local-first: the first version should assume host execution.
- Adapter-driven: each claw can have custom install, config, and run logic.
- Shared root: all managed state lives under one clawctl-owned directory.
- Explicit active selection: only one claw is active by default.
- Backend abstraction: the core product should not care whether a claw runs on the host or in Docker.
- Low lock-in: user data should be inspectable and recoverable from the filesystem.

## Supported Platform Matrix

Version 1 should target a single host platform:

- `darwin-arm64`

This keeps the first installer, runtime, and test matrix narrow enough to make real progress on the adapter system before broadening platform support.

Future platform support should be added only after the adapter model and failure recovery behavior are stable on `darwin-arm64`.

## Technical Direction

The standalone `clawctl` project will be Effect-based.

Requirements:

- use `@effect/cli` for the command surface
- use `effect` as the core application model
- represent configuration, filesystem access, process execution, downloads, and adapter execution as Effect services
- keep command handlers as thin orchestration layers over reusable Effect programs

Implications:

- do not build the CLI around Commander, Yargs, or ad hoc argv parsing
- do not mix imperative command code with separate Effect-based internals unless there is a clear boundary
- prefer typed errors, scoped resources, and Effect-managed process lifecycles

Rationale:

- this project is not only a parser for subcommands; it is a runtime manager with installs, downloads, process control, config rendering, and backend abstraction
- those concerns map well to Effect’s model for services, resource safety, retries, and structured errors
- choosing Effect early avoids a later rewrite from a thin CLI framework into a more capable runtime architecture

## Command Surface

Initial command set:

```bash
clawctl install <impl>[@version] [--runtime local]
clawctl uninstall <impl>[@version] [--runtime local]
clawctl list
clawctl list --installed
clawctl use <impl>[@version] [--runtime local]
clawctl current
clawctl doctor [<impl>[@version]]
clawctl status [<impl>[@version]]
clawctl ping [<impl>[@version]]
clawctl chat [<impl>[@version]] <message>
clawctl stop [<impl>[@version]]
clawctl config get
clawctl config set <key> <value>
```

Behavior rules:

- If no target is provided, pass-through commands use the active runtime.
- `use` may start the target runtime if needed.
- `use` should stop the previously active runtime when the transport would conflict, especially for Telegram.
- `status` should report both install status and runtime status.

## Shared Root Layout

Default root:

```text
~/.clawctl/
```

Initial layout:

```text
~/.clawctl/
  config/
    shared.env
    current.json
  installs/
    local/
      openclaw/
        2026.3.7/
      nanobot/
        0.1.4.post4/
      zeroclaw/
        v0.1.7/
  runtimes/
    openclaw/
      active/
        config/
        state/
        workspace/
  cache/
  logs/
```

Rules:

- `installs/` holds immutable installed artifacts.
- `runtimes/` holds mutable runtime data.
- `config/shared.env` stores shared credentials and defaults.
- `config/current.json` stores the active implementation, version, and backend.
- A claw may have implementation-specific config rendered into its runtime directory.
- Shared data should be limited to reusable credentials and top-level metadata.
- Runtime state, workspace data, logs, and native config should otherwise remain isolated per runtime.

## Shared Configuration

`clawctl` owns a shared config layer for values reused across claws.

Examples:

- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- default base URL
- default model

Rules:

- Shared config is the source of truth for credentials meant to be reused across claws.
- Per-claw rendered config is derived from shared config plus adapter rules.
- A claw adapter may map one shared key into a claw-specific config shape.
- API and Telegram credentials are the main shared values in v1.
- All other runtime state should remain implementation-specific unless a later design explicitly promotes it to shared state.

## Telegram Model

Telegram credentials are shared.

The initial assumption is:

- all supported claws can be configured with the same bot credentials
- only one active claw should own the bot connection at a time

Implications:

- `use` must stop the previously active claw before starting the next claw when Telegram is enabled
- the active claw receives the shared Telegram credentials during config rendering
- `clawctl` does not need to be the Telegram transport owner in v1
- only one claw should be active at a time

This keeps the design simple while respecting Telegram’s single bot update stream model.

## Runtime Backend Abstraction

The system must distinguish between:

- what a claw is
- how that claw is executed

Define a backend interface conceptually like:

- `install`
- `uninstall`
- `start`
- `stop`
- `status`
- `exec`
- `logs`
- `doctor`

In implementation terms, these operations should be exposed as Effect services rather than plain utility modules.

Initial backends:

- `local`

Planned backends:

- `docker`

The `local` backend runs binaries or scripts directly on the host.

The `docker` backend will later run the same implementation through a container, but should reuse:

- the same implementation metadata
- the same shared config model
- the same active-selection model
- the same high-level commands

## Implementation Adapter Model

Each implementation requires an adapter that describes:

- install source and version resolution
- supported backends
- runtime home/state/workspace layout
- how to render native config files
- how to start and stop the claw
- how to run `ping`
- how to run `chat`
- how to compute status
- what capabilities are supported

Examples of install strategies:

- npm package
- pip package
- release tarball
- git checkout + build

Examples of runtime strategies:

- long-running daemon
- one-shot CLI invocation
- webhook/http server
- Telegram bot process

`clawctl` should not assume these are the same across claws.

Adapters should be implemented as Effect services or Effect-driven modules so they compose cleanly with backend, config, and process layers.

## Capability Model

Not every claw will support every feature in the same way.

Each adapter should declare capabilities such as:

- `chat`
- `ping`
- `status`
- `telegram`
- `local`
- `docker`
- `daemon`
- `oneshot`

This allows `clawctl` to:

- hide unsupported commands
- fail clearly when a requested action is unavailable
- keep the shared CLI contract simple

## Installation Model

The first release should support local installation only.

Requirements:

- install versioned artifacts under `installs/local/<impl>/<version>/`
- avoid mutating system-wide toolchains when possible
- prefer hermetic or semi-hermetic installation under the clawctl root
- cache downloaded archives and intermediate build artifacts where practical

Preferred strategy order:

1. prebuilt release artifact
2. package-manager install into clawctl-owned paths
3. source build as fallback

`clawctl` should store enough metadata to know:

- where the install lives
- how it was installed
- which backend it supports
- which executable or launch command should be used

## Install Strategy Model

The main implementation complexity in `clawctl` is not command parsing.

It is the need to support multiple upstream distribution models under one user-facing workflow.

The product must not assume every claw is available as a standalone binary.

As of March 9, 2026, known claw implementations fall into several install classes:

- GitHub release binaries or archives
- npm packages
- Python packages installed via `pip` or `uv`
- repo clone plus native bootstrap/setup flow
- Docker-first projects where local host install is not the natural path

`clawctl` should standardize the install contract, not the transport used by upstream authors.

## Adapter Strategy Types

Each adapter must declare one or more install strategies.

The initial strategy types are:

### `github-release`

For implementations that publish versioned release assets.

Requirements:

- resolve a release by version or latest tag
- choose the correct asset for host OS and architecture
- download into the clawctl cache
- verify checksums or signatures when upstream provides them
- unpack or install into `installs/local/<impl>/<version>/`

Best fit:

- `nullclaw`
- `picoclaw`
- `zeroclaw`

### `npm-package`

For implementations distributed primarily through npm.

Requirements:

- install into a clawctl-owned prefix, not a global system prefix
- record package name and resolved version
- expose the resolved executable path to the runtime layer
- avoid relying on a user-global Node environment after installation

Best fit:

- `openclaw`

### `python-package`

For implementations distributed as Python packages.

Requirements:

- install into a clawctl-owned environment
- prefer `uv` or a dedicated virtual environment over system Python mutation
- record interpreter path, package name, and resolved version
- expose the correct entrypoint command to the runtime layer

Best fit:

- `nanobot`
- `takopi`

### `repo-bootstrap`

For implementations whose normal setup path is “clone the repo and run its setup flow”.

Requirements:

- clone a pinned repo revision or tag into a clawctl-owned source cache
- run the adapter-defined bootstrap flow
- record bootstrap provenance and resulting entrypoint
- treat this as less deterministic than binary/package installs

Best fit:

- `nanoclaw`
- `bitclaw`

### `docker-build`

For implementations where Docker is the natural runtime and install boundary.

Requirements:

- clone or use local build context
- build or pull an image
- record image tag or digest
- hand off runtime concerns to the Docker backend

Best fit:

- `piclaw`
- fallback path for any implementation that is painful to support locally

### `source-build`

For implementations that require a native build step even in local mode.

Requirements:

- declare build prerequisites explicitly
- keep build output under a clawctl-owned install directory
- record the source revision and build toolchain assumptions

This should be treated as a last-resort strategy, not the default v1 path.

## Install Pipeline

Regardless of strategy, `clawctl install` should follow the same high-level pipeline:

1. resolve the requested implementation and version
2. select a supported install strategy for the requested backend
3. verify host compatibility
4. fetch or prepare artifacts into the cache
5. verify provenance where possible
6. materialize the install into the shared install root
7. write install metadata
8. expose a runtime entrypoint for `use`, `status`, `ping`, and `chat`

This pipeline should be adapter-driven but operationally uniform.

## Install Metadata Requirements

Each installed runtime should record:

- implementation id
- requested version
- resolved version
- backend
- install strategy type
- install root
- entrypoint command
- host platform and architecture
- source URL, package name, or repo reference
- checksum or signature metadata when available
- install timestamp
- support tier at the time of install

This metadata is necessary for reliable `current`, `status`, uninstall, and future upgrades.

## Adapter Manifest Contract

`clawctl` should use a hybrid adapter model:

- declarative manifest for stable metadata
- Effect code for strategy execution and complex runtime behavior

The manifest must be expressive enough to cover ordinary install, config, and runtime cases without forcing every adapter to be handwritten from scratch.

The manifest must not attempt to encode arbitrary shell logic as the primary execution model.

## Declarative vs Imperative Boundary

### Declarative manifest responsibilities

The manifest should describe:

- implementation identity
- support tier
- supported backends
- supported install strategies
- version source and version policy
- capability flags
- install artifact selection rules
- runtime mode
- config template inputs and outputs
- default health, ping, and chat modes where simple

### Imperative adapter responsibilities

Effect-backed adapter code should handle:

- nontrivial version resolution
- asset selection logic too complex for plain pattern matching
- package-manager invocation
- repo bootstrap flows
- process supervision
- streaming I/O
- interactive or stateful setup flows
- any behavior that depends on host inspection or rich error recovery

The rule is:

- make metadata declarative when it is stable and testable
- use code when the behavior is procedural, stateful, or upstream-specific

## Manifest Shape

At a high level, each implementation should define:

```ts
type ImplementationManifest = {
  id: string
  displayName: string
  supportTier: "tier1" | "tier2" | "tier3"
  description: string
  repository?: string
  docsUrl?: string
  backends: BackendManifest[]
  capabilities: CapabilityManifest
  config: ConfigManifest
}
```

### Backend manifest

```ts
type BackendManifest = {
  kind: "local" | "docker"
  supported: boolean
  install: InstallManifest[]
  runtime: RuntimeManifest
}
```

### Install manifest

```ts
type InstallManifest =
  | GithubReleaseInstallManifest
  | NpmPackageInstallManifest
  | PythonPackageInstallManifest
  | RepoBootstrapInstallManifest
  | DockerBuildInstallManifest
  | SourceBuildInstallManifest
```

Shared install fields:

```ts
type InstallCommon = {
  strategy: string
  priority: number
  supportedPlatforms: PlatformSelector[]
  versionSource: VersionSourceManifest
}
```

### Runtime manifest

```ts
type RuntimeManifest = {
  mode: "oneshot" | "daemon" | "http" | "telegram-bot"
  homeStrategy: "isolated-home" | "native-home" | "custom-env"
  workspaceStrategy: "shared" | "per-implementation" | "per-runtime"
  entrypoint:
    | {
        kind: "exec"
        command: string[]
      }
    | {
        kind: "adapter-hook"
        hook: string
      }
  health:
    | { kind: "none" }
    | { kind: "process" }
    | { kind: "http"; path?: string; port?: number }
    | { kind: "adapter-hook"; hook: string }
  chat:
    | { kind: "argv"; command: string[] }
    | { kind: "http"; path: string; method: "POST" }
    | { kind: "adapter-hook"; hook: string }
  ping:
    | { kind: "prompt"; text: string }
    | { kind: "http"; path: string; method: "GET" | "POST" }
    | { kind: "adapter-hook"; hook: string }
}
```

### Config manifest

```ts
type ConfigManifest = {
  sharedKeys: SharedConfigKey[]
  files: ConfigFileManifest[]
  env: ConfigEnvManifest[]
}
```

```ts
type ConfigFileManifest = {
  path: string
  format: "json" | "toml" | "yaml" | "env" | "text"
  template:
    | { kind: "inline"; value: string }
    | { kind: "file"; path: string }
    | { kind: "adapter-hook"; hook: string }
  requiredKeys: string[]
}

type SharedConfigKey = string

type ConfigEnvManifest = {
  name: string
  valueFrom:
    | { kind: "shared-key"; key: SharedConfigKey }
    | { kind: "literal"; value: string }
    | { kind: "adapter-hook"; hook: string }
}
```

### Capability manifest

```ts
type CapabilityManifest = {
  chat: boolean
  ping: boolean
  status: boolean
  telegram: boolean
  local: boolean
  docker: boolean
  oneshot: boolean
  daemon: boolean
}
```

## Version Source Contract

Version resolution should be explicitly modeled.

```ts
type VersionSourceManifest =
  | { kind: "github-releases"; repository: string }
  | { kind: "npm"; packageName: string }
  | { kind: "pypi"; packageName: string }
  | { kind: "git-tags"; repository: string }
  | { kind: "static"; versions: string[] }
  | { kind: "adapter-hook"; hook: string }
```

Rules:

- every adapter must declare how versions are discovered
- version resolution should be testable without starting the runtime
- adapters may pin defaults, but the resolution source must still be explicit

## Platform Selector Contract

Platform matching should be declarative where possible.

```ts
type PlatformSelector = {
  os: "darwin" | "linux" | "windows"
  arch: "x64" | "arm64" | "armv7" | "riscv64" | "other"
  libc?: "gnu" | "musl"
}
```

This is especially important for release-asset-backed adapters.

## Release Asset Mapping

For `github-release`, the manifest should support asset rules such as:

```ts
type GithubReleaseInstallManifest = InstallCommon & {
  strategy: "github-release"
  repository: string
  assetRules: Array<{
    match: PlatformSelector
    pattern: string
    archive:
      | { kind: "none" }
      | { kind: "tar.gz"; binaryPath: string }
      | { kind: "zip"; binaryPath: string }
  }>
  verification?:
    | { kind: "none" }
    | { kind: "checksum-file"; assetPattern: string }
    | { kind: "sigstore"; assetPattern: string }
}
```

This lets Tier 1 adapters stay mostly declarative.

## Package-Manager Strategy Fields

For `npm-package`:

```ts
type NpmPackageInstallManifest = InstallCommon & {
  strategy: "npm-package"
  packageName: string
  binName: string
}
```

For `python-package`:

```ts
type PythonPackageInstallManifest = InstallCommon & {
  strategy: "python-package"
  packageName: string
  installer: "uv-tool" | "uv-venv" | "pip-venv"
  entrypoint: string
}
```

These still need Effect code to execute the install, but the metadata can remain declarative.

## Repo Bootstrap Strategy Fields

For `repo-bootstrap`:

```ts
type RepoBootstrapInstallManifest = InstallCommon & {
  strategy: "repo-bootstrap"
  repository: string
  refPolicy: "tag" | "branch" | "commit"
  bootstrapHook: string
}
```

This strategy must be treated as lower-confidence than release or package installs.

## Hook Contract

Whenever a manifest references `adapter-hook`, the hook name should resolve to a typed Effect implementation in the adapter module.

Hooks should be limited to well-known phases:

- `resolveVersions`
- `install`
- `renderConfig`
- `start`
- `stop`
- `status`
- `ping`
- `chat`
- `doctor`

This avoids ad hoc unbounded scripting while still allowing escape hatches.

## Example Tier 1 Manifest

Illustrative example for a release-backed local adapter:

```ts
const zeroclawManifest = {
  id: "zeroclaw",
  displayName: "ZeroClaw",
  supportTier: "tier1",
  description: "Release-backed local install via GitHub archives",
  repository: "https://github.com/zeroclaw-labs/zeroclaw",
  capabilities: {
    chat: true,
    ping: true,
    status: true,
    telegram: true,
    local: true,
    docker: true,
    oneshot: true,
    daemon: false,
  },
  config: {
    sharedKeys: ["OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"],
    files: [
      {
        path: "config/config.toml",
        format: "toml",
        template: { kind: "file", path: "./templates/zeroclaw.config.toml" },
        requiredKeys: ["OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"],
      },
    ],
    env: [],
  },
  backends: [
    {
      kind: "local",
      supported: true,
      install: [
        {
          strategy: "github-release",
          priority: 1,
          repository: "zeroclaw-labs/zeroclaw",
          versionSource: { kind: "github-releases", repository: "zeroclaw-labs/zeroclaw" },
          supportedPlatforms: [
            { os: "darwin", arch: "arm64" },
            { os: "darwin", arch: "x64" },
            { os: "linux", arch: "arm64", libc: "gnu" },
            { os: "linux", arch: "x64", libc: "gnu" },
          ],
          assetRules: [
            {
              match: { os: "darwin", arch: "arm64" },
              pattern: "zeroclaw-aarch64-apple-darwin.tar.gz",
              archive: { kind: "tar.gz", binaryPath: "zeroclaw" },
            },
          ],
          verification: { kind: "checksum-file", assetPattern: "SHA256SUMS" },
        },
      ],
      runtime: {
        mode: "oneshot",
        homeStrategy: "isolated-home",
        workspaceStrategy: "shared",
        entrypoint: { kind: "exec", command: ["{installRoot}/bin/zeroclaw"] },
        health: { kind: "none" },
        chat: { kind: "adapter-hook", hook: "chat" },
        ping: { kind: "prompt", text: "Reply with exactly the single word pong." },
      },
    },
  ],
} satisfies ImplementationManifest
```

## Example Tier 2 Manifest

Illustrative example for a package-manager-backed adapter:

```ts
const openclawManifest = {
  id: "openclaw",
  displayName: "OpenClaw",
  supportTier: "tier2",
  description: "npm-backed local install",
  repository: "https://github.com/openclaw/openclaw",
  capabilities: {
    chat: true,
    ping: true,
    status: true,
    telegram: true,
    local: true,
    docker: true,
    oneshot: true,
    daemon: true,
  },
  config: {
    sharedKeys: ["OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"],
    files: [
      {
        path: "config/openclaw.json",
        format: "json",
        template: { kind: "file", path: "./templates/openclaw.json" },
        requiredKeys: ["OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN"],
      },
    ],
    env: [],
  },
  backends: [
    {
      kind: "local",
      supported: true,
      install: [
        {
          strategy: "npm-package",
          priority: 1,
          packageName: "openclaw",
          binName: "openclaw",
          versionSource: { kind: "npm", packageName: "openclaw" },
          supportedPlatforms: [
            { os: "darwin", arch: "arm64" },
            { os: "darwin", arch: "x64" },
            { os: "linux", arch: "arm64" },
            { os: "linux", arch: "x64" },
          ],
        },
      ],
      runtime: {
        mode: "telegram-bot",
        homeStrategy: "isolated-home",
        workspaceStrategy: "shared",
        entrypoint: { kind: "adapter-hook", hook: "start" },
        health: { kind: "adapter-hook", hook: "status" },
        chat: { kind: "adapter-hook", hook: "chat" },
        ping: { kind: "adapter-hook", hook: "ping" },
      },
    },
  ],
} satisfies ImplementationManifest
```

These examples are illustrative, not final source-of-truth definitions.

## Manifest Validation Requirements

`clawctl doctor` should validate adapter manifests before any install or start:

- required fields exist
- version sources are coherent
- strategy/backends are compatible
- templates reference known shared config keys
- declared capabilities match runtime shape
- hook names resolve to real adapter implementations

This is necessary because the adapter layer is the main project risk surface.

## Support Tiers

`clawctl` should define support tiers explicitly.

“Supported” must mean more than “we know this project exists”.

### Tier 1: First-Class Local

Definition:

- local installation is a primary supported path upstream
- install is deterministic enough for ordinary users
- `install`, `use`, `current`, `status`, `ping`, and `chat` are expected to work
- no repo-clone bootstrap flow is required for ordinary usage

Current bucket:

- `nullclaw`
- `picoclaw`
- `zeroclaw`

These are the best candidates for early implementation because they publish versioned release assets for common platforms.

### Tier 2: Package-Managed Local

Definition:

- local installation is viable, but depends on a managed language toolchain
- `clawctl` must own npm or Python install isolation
- user experience can still be first-class, but implementation complexity is higher than Tier 1

Current bucket:

- `openclaw`
- `nanobot`
- `takopi`

These should still be in scope for local mode, but they require package-manager-specific adapter logic rather than simple binary downloads.

### Tier 3: Experimental Local or Docker-First

Definition:

- local installation is bootstrap-heavy, repo-driven, or not the natural upstream path
- the project may be better served by Docker support first
- `clawctl` may expose these as experimental, docker-only, or unsupported in local mode

Current bucket:

- `nanoclaw`
- `bitclaw`
- `piclaw`

These should not block the v1 local installer architecture.

## Tier Semantics

Support tiers affect user promises:

- Tier 1 means first-class support in docs and CLI help
- Tier 2 means supported, but adapter-owned toolchain setup is part of the contract
- Tier 3 means experimental, docker-first, or deferred

`clawctl list` and `clawctl doctor` should surface support tiers clearly.

## Initial Implementation Priority

Recommended build order:

1. Tier 1 local adapters
2. one Tier 2 npm adapter
3. one Tier 2 Python adapter
4. metadata and upgrade/uninstall paths
5. Docker backend
6. Tier 3 adapters

This sequence validates the adapter architecture before taking on repo-bootstrap and docker-first projects.

## Known Claw Buckets

As of March 9, 2026, the known claws discussed so far group as follows:

- Tier 1 local
  - `nullclaw`: release binaries
  - `picoclaw`: release archives and packages
  - `zeroclaw`: release archives with checksum/signature metadata

- Tier 2 local
  - `openclaw`: npm package
  - `nanobot`: Python package
  - `takopi`: Python package via `uv`

- Tier 3 experimental or docker-first
  - `nanoclaw`: repo clone plus Claude Code setup
  - `bitclaw`: repo clone plus Claude Code setup
  - `piclaw`: Docker-first web runtime

This list should live in adapter metadata in the implementation, but the spec should define the categorization model.

## Active Selection Model

`clawctl use <impl>[@version]` should:

1. validate the target is installed
2. render native config for the target from shared config
3. stop the currently active runtime
4. mark the new runtime as active
5. start the new runtime if the adapter requires a resident process

`clawctl current` should display:

- implementation
- version
- backend
- install path
- runtime path
- current status

Lifecycle rules:

- `use` should always stop the previously active runtime before switching
- only one runtime should be active at a time
- `chat` against the active claw should auto-start the runtime if it is stopped
- `ping` does not need to auto-start by default; it may report that the runtime is stopped

## Pass-Through Commands

### `ping`

`ping` is the smallest known-good health interaction.

Requirements:

- adapter-owned prompt or health check
- normalized success/failure result
- include raw response when useful

### `chat`

`chat` sends a user message directly to the claw.

Requirements:

- target active runtime by default
- allow explicit implementation/version override later
- pass through as directly as practical
- do not over-normalize response formatting in v1

### `status`

`status` should report:

- whether the target is installed
- whether it is active
- whether its process is running
- any adapter-specific health detail

## Config Rendering

Shared config is not enough on its own.

Each adapter must be able to render native config into the runtime directory using:

- shared credential values
- shared defaults
- implementation-specific templates
- optional user overrides

This is necessary because claws may require:

- JSON, TOML, YAML, or env files
- different field names
- different default directories
- different Telegram config blocks

## Local Backend Design Requirements

The `local` backend should:

- install without requiring Docker
- avoid writing into the user’s real home directory where possible
- keep runtime state under the clawctl root
- support host OS checks and clear install failures
- be restartable and inspectable

Open point:

- some upstream tools may still assume `HOME`-relative behavior; adapters may need to set `HOME` or tool-specific env vars to the runtime root

## Docker Backend Design Requirements

Docker is not in scope for v1 implementation, but it must be easy to add.

To preserve that path:

- do not hardcode local filesystem assumptions into the command model
- keep backend-specific logic behind a runtime interface
- keep config rendering separate from backend execution
- keep install metadata backend-aware

The Docker backend should eventually support:

- image build or image pull
- runtime volume mapping
- the same shared config injection model
- the same active-selection semantics

## Metadata

`clawctl` should maintain machine-readable metadata for:

- installed versions
- backend support
- active runtime
- install provenance
- adapter capability declarations

Suggested files:

```text
~/.clawctl/config/current.json
~/.clawctl/installs/index.json
~/.clawctl/runtimes/index.json
```

These do not need to be the final filenames, but the product needs equivalent state.

Reads and writes for this metadata should flow through Effect-based persistence services so test and production environments can swap implementations cleanly.

## Error Handling

Errors should be direct and operational.

Examples:

- unsupported implementation
- version not installed
- backend not supported for this implementation
- shared credential missing
- native config render failed
- local dependency missing
- active claw failed to start

`clawctl` should not hide adapter-specific stderr when install or startup fails.

Failure recovery is a core objective.

Requirements:

- interrupted downloads should not be treated as successful installs
- partial installs should be detectable and removable
- install metadata should be written atomically where practical
- `clawctl` should prefer resumable or retryable fetches when the underlying strategy allows it
- uninstall and reinstall should be safe recovery paths
- recovery behavior should be tested, not assumed

## Upgrade and Reinstall Semantics

The default upgrade model should be conservative and explicit.

Rules:

- `install <impl>` without a version means install the latest resolvable upstream version
- installing a second version should not replace an existing versioned install
- `use` should target an installed version and should not implicitly install missing versions
- reinstalling the same version should either be a no-op or require an explicit force mode later
- downgrades are just `use` on an older installed version or an explicit install of that version

This keeps the initial behavior predictable while leaving room for richer upgrade commands later.

Version policy:

- v1 should be latest-by-default
- adapters may still declare known-good versions for testing or documentation
- users should always be able to request an explicit version when the strategy supports it

## Verification Policy

Verification policy is adapter-sensitive and requires upstream research.

V1 objective:

- record what verification material each upstream project exposes
- use checksum or signature verification where upstream provides it
- surface missing verification material in adapter metadata and `doctor`

Policy choice:

- verification is best-effort for all tiers in v1
- if upstream exposes checksums or signatures, `clawctl` should use them
- if upstream does not expose verification material, install may still proceed
- missing verification material should be visible in adapter metadata, doctor output, and support-tier evaluation

This keeps adoption practical while preserving visibility into trust gaps.

## Testing Objectives

Automated testing is required.

Minimum expectations:

- adapter manifest validation tests
- install strategy unit tests
- metadata persistence tests
- runtime lifecycle tests for `use`, `current`, `status`, and `stop`
- recovery-path tests for partial install and failed start scenarios

Tier expectations:

- Tier 1 adapters should have end-to-end automated install/use/ping coverage on the supported platform
- Tier 2 adapters should have automated install and smoke coverage, with toolchain assumptions clearly documented
- Tier 3 adapters may begin with lighter validation until their support level changes

## Tier 2 Runtime Vendoring

Tier 2 local installs should use a semi-hermetic model.

Rules:

- package installs should live under the clawctl root
- adapter-owned metadata should record the package-manager environment used for installation
- the install should avoid mutating user-global package locations
- the host interpreter or runtime may still be used when full vendoring is not yet practical

This is a middle ground:

- more reproducible than thin wrapper installs
- much simpler than fully vendoring complete language runtimes in v1

## Release Posture

Initial release posture:

- source-first Bun application

Planned later posture:

- packaged standalone binary release

Implications:

- v1 development can assume Bun is available
- packaging concerns should not dominate the first implementation pass
- runtime and adapter code should still be written so a later binary packaging step is straightforward

## Adapter Ownership

For now, adapters are repo-owned.

Implications:

- there is no external adapter plugin system in v1
- adapter APIs can evolve more aggressively while the core model stabilizes
- third-party adapter extensibility can be revisited later if the manifest and hook contracts prove stable

## Tier 3 Posture

Tier 3 should default to bootstrap-heavy experimental support rather than immediate docker-only or fully unsupported status.

Rules:

- if a claw has a plausible local path but requires repo clone plus setup, classify it as experimental Tier 3 local
- if a claw is naturally container-native and local support would be artificial, classify it as docker-first Tier 3
- Tier 3 should not make first-class support promises until automation and recovery behavior improve

This means:

- `nanoclaw` and `bitclaw` fit experimental/bootstrap-heavy Tier 3 local
- `piclaw` still fits docker-first Tier 3

## UX Requirements

- Commands should work with minimal required flags.
- `use` should be the default way to switch claws.
- The active claw should be obvious in `current` and `status`.
- Shared config should be easy to inspect and edit.
- Failures should clearly separate install problems, config problems, and runtime problems.

## Security and Secrets

- Shared credentials must live in clawctl-owned config files with restricted permissions when possible.
- Secrets should not be echoed in normal command output.
- Rendered per-claw configs may contain secrets, so runtime directories should be treated as sensitive.
- Logs should avoid printing secrets unless a debug mode is explicitly requested.

## Initial Scope

Version 1 should include:

- local backend only
- shared config
- installed-version tracking
- active runtime selection
- `install`, `list`, `use`, `current`, `ping`, `chat`, `status`, `stop`
- at least one adapter shape that supports one-shot CLI and one adapter shape that supports a resident process
- Tier 1 local support
- at least one Tier 2 local adapter path to validate package-manager-backed installs
- `darwin-arm64` support only
- repo-owned adapters only
- automated tests for adapter manifests, install paths, runtime lifecycle, and recovery paths

Version 1 does not need:

- docker backend
- auto-upgrade logic
- plugin marketplace
- universal response normalization
- session migration across implementations
- Tier 3 local support
- cross-platform support beyond `darwin-arm64`

## Open Questions

- Should latest-by-default eventually gain named channels like `stable` and `latest`?
- Should Tier 2 semi-hermetic installs grow into full runtime vendoring later?
- What criteria should move a Tier 3 adapter into Tier 2 or Tier 1?
- Should verification policy remain best-effort once the supported platform matrix broadens?

## Recommended Architecture

Split the project into three layers:

1. Core CLI
   - argument parsing
   - state management
   - active selection
   - shared config

2. Adapters
   - implementation-specific install/config/run logic

3. Backends
   - `local` now
   - `docker` later

Implementation guidance:

- Core CLI: `@effect/cli`
- Core runtime and services: `effect`
- Node integration: Effect platform services for filesystem, process, path, and terminal concerns
- Adapters and backends should be dependency-injected through Effect layers

This keeps the product centered on the user workflow rather than on the current benchmark container setup, while still giving the codebase one consistent programming model.

## Success Criteria

The project is successful when a user can:

- install two different claws under one root
- configure shared API and Telegram credentials once
- switch the active claw with one command
- send a test message to the active claw
- inspect whether the active claw is installed and running
- add a future Docker backend without redesigning the CLI around containers

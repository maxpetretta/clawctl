import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  BackendManifest,
  CapabilityManifest,
  ConfigFileManifest,
  ConfigManifest,
  ImplementationManifest,
  RuntimeManifest,
  SharedConfigKey,
} from "./schema.ts"
import type { RegisteredImplementation } from "./types.ts"

type ImplementationHook = {
  buildChatCommand: (input: {
    binaryPath: string
    installRoot: string
    homeDir: string
    message: string
    port?: number
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => string[]
  chat?: (input: {
    binaryPath: string
    installRoot: string
    homeDir: string
    message: string
    port?: number
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => Promise<string>
  install?: (input: {
    installRoot: string
    requestedVersion: string
    resolvedVersion: string
    stageRoot: string
  }) => Promise<{
    entrypointCommand: string[]
  }>
  start?: (input: {
    binaryPath: string
    installRoot: string
    homeDir: string
    record: {
      implementation: string
      resolvedVersion: string
    }
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => Promise<{
    args: string[]
    command: string
    env?: NodeJS.ProcessEnv
    port?: number
  }>
  resolveVersions?: () => Promise<ReadonlyArray<string>>
  status?: (input: {
    binaryPath: string
    installRoot: string
    homeDir: string
    port?: number
    record: {
      implementation: string
      resolvedVersion: string
    }
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => Promise<boolean>
  renderConfig: (input: { config: Record<string, string>; workspaceDir: string }) => Promise<
    Array<{
      content: string
      path: string
    }>
  >
  normalizeChatOutput?: (input: { stdout: string; stderr: string }) => string
  runtimeEnv: (input: {
    homeDir: string
    installRoot: string
    port?: number
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => NodeJS.ProcessEnv
}

type AdapterRegistration = RegisteredImplementation & {
  hooks: {
    buildChatCommand: true
    chat?: true
    install?: true
    normalizeChatOutput?: true
    resolveVersions?: true
    renderConfig: true
    start?: true
    status?: true
    runtimeEnv: true
  }
  implementationHooks: ImplementationHook
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(currentDir, "../..")
const templateDir = resolve(packageDir, "templates")

const sharedKeys = ["CLAW_API_KEY", "CLAW_BASE_URL", "CLAW_MODEL"] as const satisfies readonly SharedConfigKey[]

function makeCapabilities(overrides?: Partial<CapabilityManifest>): CapabilityManifest {
  return {
    chat: true,
    ping: true,
    status: true,
    telegram: false,
    local: true,
    docker: false,
    daemon: true,
    ...overrides,
  }
}

function makeNativeDaemonRuntime(): RuntimeManifest {
  return {
    supervision: { kind: "native-daemon" },
    homeStrategy: "isolated-home",
    workspaceStrategy: "per-runtime",
    entrypoint: { kind: "adapter-hook", hook: "start" },
    health: { kind: "adapter-hook", hook: "status" },
    chat: { kind: "adapter-hook", hook: "chat" },
    ping: { kind: "prompt", text: "Reply with exactly the single word pong." },
  }
}

function makeConfig(
  files: ConfigFileManifest[],
  sharedConfigKeys: readonly SharedConfigKey[] = sharedKeys,
): ConfigManifest {
  return {
    sharedKeys: [...sharedConfigKeys],
    files,
    env: [],
  }
}

function loadTemplate(templateName: string): Promise<string> {
  return Bun.file(resolve(templateDir, templateName)).text()
}

async function renderTemplate(templateName: string, replacements: Record<string, string>): Promise<string> {
  const template = await loadTemplate(templateName)
  return template.replaceAll(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key: string) => replacements[key] ?? "")
}

function makeReleaseBackend(input: BackendManifest["install"][number], runtime: RuntimeManifest): BackendManifest {
  return {
    kind: "local",
    supported: true,
    install: [input],
    runtime,
  }
}

function makeUnmanagedRuntime(): RuntimeManifest {
  return {
    supervision: { kind: "unmanaged" },
    homeStrategy: "isolated-home",
    workspaceStrategy: "per-runtime",
    entrypoint: { kind: "exec", command: [] },
    health: { kind: "none" },
    chat: { kind: "argv", command: [] },
    ping: { kind: "prompt", text: "" },
  }
}

function makeInstallOnlyHooks() {
  return {
    hooks: {
      buildChatCommand: true,
      resolveVersions: true,
      renderConfig: true,
      runtimeEnv: true,
    },
    implementationHooks: {
      buildChatCommand: () => [],
      resolveVersions: async () => ["main"],
      renderConfig: async () => [],
      runtimeEnv: () => ({}),
    },
  } satisfies Pick<AdapterRegistration, "hooks" | "implementationHooks">
}

function makeReleaseInstallOnlyRegistration(input: {
  assetPattern: string
  assetArchive: Exclude<
    BackendManifest["install"][number],
    { strategy: "npm-package" | "python-package" | "repo-bootstrap" | "docker-build" | "source-build" }
  >["assetRules"][number]["archive"]
  description: string
  displayName: string
  docsUrl: string
  id: string
  repository: string
  versionSourceRepository?: string
}) {
  return {
    manifest: {
      id: input.id,
      displayName: input.displayName,
      supportTier: "tier3",
      description: input.description,
      repository: `https://github.com/${input.repository}`,
      docsUrl: input.docsUrl,
      capabilities: makeCapabilities({
        chat: false,
        ping: false,
        telegram: true,
        daemon: true,
      }),
      config: makeConfig([], []),
      backends: [
        {
          kind: "local",
          supported: true,
          install: [
            {
              strategy: "github-release",
              priority: 1,
              repository: input.repository,
              versionSource: {
                kind: "github-releases",
                repository: input.versionSourceRepository ?? input.repository,
              },
              supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
              assetRules: [
                {
                  match: { os: "darwin", arch: "arm64" },
                  pattern: input.assetPattern,
                  archive: input.assetArchive,
                },
              ],
              verification: { kind: "none" },
            },
          ],
          runtime: makeUnmanagedRuntime(),
        },
      ],
    } satisfies ImplementationManifest,
    ...makeInstallOnlyHooks(),
  } satisfies AdapterRegistration
}

const nullclawRegistration = {
  manifest: {
    id: "nullclaw",
    displayName: "NullClaw",
    supportTier: "tier1",
    description: "Release-backed local adapter with native daemon supervision",
    repository: "https://github.com/nullclaw/nullclaw",
    docsUrl: "https://github.com/nullclaw/nullclaw",
    capabilities: makeCapabilities(),
    config: makeConfig([
      {
        path: ".nullclaw/config.json",
        format: "json",
        template: { kind: "file", path: resolve(templateDir, "nullclaw.config.json.template") },
        requiredKeys: [...sharedKeys],
      },
    ]),
    backends: [
      makeReleaseBackend(
        {
          strategy: "github-release",
          priority: 1,
          repository: "nullclaw/nullclaw",
          versionSource: { kind: "github-releases", repository: "nullclaw/nullclaw" },
          supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          assetRules: [
            {
              match: { os: "darwin", arch: "arm64" },
              pattern: "nullclaw-macos-aarch64.bin",
              archive: { kind: "none" },
            },
          ],
          verification: { kind: "none" },
        },
        makeNativeDaemonRuntime(),
      ),
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, message }) => [binaryPath, "agent", "-m", message],
    renderConfig: async ({ config, workspaceDir }) => [
      {
        path: ".nullclaw/config.json",
        content: await renderTemplate("nullclaw.config.json.template", {
          ...config,
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot, workspaceDir }) => ({
      HOME: homeDir,
      NULLCLAW_HOME: resolve(homeDir, ".nullclaw"),
      NULLCLAW_WORKSPACE: workspaceDir,
      CLAWCTL_INSTALL_ROOT: installRoot,
    }),
    start: ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir, workspaceDir }) =>
      Promise.resolve({
        command: binaryPath,
        args: ["gateway"],
        env: {
          HOME: homeDir,
          NULLCLAW_HOME: resolve(homeDir, ".nullclaw"),
          NULLCLAW_WORKSPACE: workspaceDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
        },
      }),
    status: async ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir, workspaceDir }) => {
      const child = Bun.spawn([binaryPath, "status"], {
        env: {
          ...process.env,
          HOME: homeDir,
          NULLCLAW_HOME: resolve(homeDir, ".nullclaw"),
          NULLCLAW_WORKSPACE: workspaceDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
        },
        stderr: "ignore",
        stdout: "ignore",
      })
      return (await child.exited) === 0
    },
  },
} satisfies AdapterRegistration

const picoclawRegistration = {
  manifest: {
    id: "picoclaw",
    displayName: "PicoClaw",
    supportTier: "tier1",
    description: "Release-backed local adapter with native daemon supervision",
    repository: "https://github.com/sipeed/picoclaw",
    docsUrl: "https://github.com/sipeed/picoclaw",
    capabilities: makeCapabilities(),
    config: makeConfig([
      {
        path: ".picoclaw/config.json",
        format: "json",
        template: { kind: "file", path: resolve(templateDir, "picoclaw.config.json.template") },
        requiredKeys: [...sharedKeys],
      },
    ]),
    backends: [
      makeReleaseBackend(
        {
          strategy: "github-release",
          priority: 1,
          repository: "sipeed/picoclaw",
          versionSource: { kind: "github-releases", repository: "sipeed/picoclaw" },
          supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          assetRules: [
            {
              match: { os: "darwin", arch: "arm64" },
              pattern: "picoclaw_Darwin_arm64.tar.gz",
              archive: { kind: "tar.gz", binaryPath: "picoclaw" },
            },
          ],
          verification: { kind: "checksum-file", assetPattern: "picoclaw_0.2.0_checksums.txt" },
        },
        makeNativeDaemonRuntime(),
      ),
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, message }) => [
      binaryPath,
      "agent",
      "--session",
      "clawctl",
      "--model",
      "bench",
      "-m",
      message,
    ],
    renderConfig: async ({ config, workspaceDir }) => [
      {
        path: ".picoclaw/config.json",
        content: await renderTemplate("picoclaw.config.json.template", {
          ...config,
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot }) => ({
      HOME: homeDir,
      PICOCLAW_HOME: homeDir,
      CLAWCTL_INSTALL_ROOT: installRoot,
    }),
    start: ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) =>
      Promise.resolve({
        command: binaryPath,
        args: ["gateway"],
        env: {
          HOME: homeDir,
          PICOCLAW_HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
        },
      }),
    status: async ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) => {
      const child = Bun.spawn([binaryPath, "status"], {
        env: {
          ...process.env,
          HOME: homeDir,
          PICOCLAW_HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
        },
        stderr: "ignore",
        stdout: "ignore",
      })
      return (await child.exited) === 0
    },
  },
} satisfies AdapterRegistration

const zeroclawRegistration = {
  manifest: {
    id: "zeroclaw",
    displayName: "ZeroClaw",
    supportTier: "tier1",
    description: "Release-backed local adapter with native daemon supervision",
    repository: "https://github.com/zeroclaw-labs/zeroclaw",
    docsUrl: "https://github.com/zeroclaw-labs/zeroclaw",
    capabilities: makeCapabilities(),
    config: makeConfig([
      {
        path: ".zeroclaw/config.toml",
        format: "toml",
        template: { kind: "file", path: resolve(templateDir, "zeroclaw.config.toml.template") },
        requiredKeys: [...sharedKeys],
      },
    ]),
    backends: [
      makeReleaseBackend(
        {
          strategy: "github-release",
          priority: 1,
          repository: "zeroclaw-labs/zeroclaw",
          versionSource: { kind: "github-releases", repository: "zeroclaw-labs/zeroclaw" },
          supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          assetRules: [
            {
              match: { os: "darwin", arch: "arm64" },
              pattern: "zeroclaw-aarch64-apple-darwin.tar.gz",
              archive: { kind: "tar.gz", binaryPath: "zeroclaw" },
            },
          ],
          verification: { kind: "checksum-file", assetPattern: "SHA256SUMS" },
        },
        makeNativeDaemonRuntime(),
      ),
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, message }) => [binaryPath, "agent", "-m", message],
    renderConfig: async ({ config, workspaceDir }) => [
      {
        path: ".zeroclaw/config.toml",
        content: await renderTemplate("zeroclaw.config.toml.template", {
          ...config,
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot }) => ({
      HOME: homeDir,
      CLAWCTL_INSTALL_ROOT: installRoot,
    }),
    start: ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) =>
      Promise.resolve({
        command: binaryPath,
        args: ["daemon"],
        env: {
          HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
        },
      }),
    status: async ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) => {
      const child = Bun.spawn([binaryPath, "status"], {
        env: {
          ...process.env,
          HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
        },
        stderr: "ignore",
        stdout: "ignore",
      })
      return (await child.exited) === 0
    },
  },
} satisfies AdapterRegistration

const openclawRegistration = {
  manifest: {
    id: "openclaw",
    displayName: "OpenClaw",
    supportTier: "tier2",
    description: "Package-managed local adapter with native gateway supervision",
    repository: "https://github.com/openclaw/openclaw",
    docsUrl: "https://github.com/openclaw/openclaw",
    capabilities: makeCapabilities(),
    config: makeConfig([
      {
        path: ".openclaw/openclaw.json",
        format: "json",
        template: { kind: "file", path: resolve(templateDir, "openclaw.config.json.template") },
        requiredKeys: [...sharedKeys],
      },
    ]),
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
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeNativeDaemonRuntime(),
      },
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    normalizeChatOutput: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, message }) => [
      binaryPath,
      "--no-color",
      "agent",
      "--json",
      "--session-id",
      "clawctl",
      "--agent",
      "main",
      "--message",
      message,
    ],
    normalizeChatOutput: ({ stdout, stderr }) => {
      const parsed = JSON.parse(stdout) as Record<string, unknown>
      const candidates = [parsed.response, parsed.reply, parsed.message, parsed.output, parsed.payloads, parsed.text]

      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) {
          return candidate
        }

        if (candidate && typeof candidate === "object" && "text" in candidate) {
          const text = candidate.text
          if (typeof text === "string" && text.length > 0) {
            return text
          }
        }

        if (Array.isArray(candidate)) {
          const [first] = candidate
          if (first && typeof first === "object" && "text" in first) {
            const text = first.text
            if (typeof text === "string" && text.length > 0) {
              return text
            }
          }
        }
      }

      const detail = stderr.trim() || stdout.trim()
      throw new Error(`openclaw did not return chat text: ${detail}`)
    },
    renderConfig: async ({ config, workspaceDir }) => [
      {
        path: ".openclaw/openclaw.json",
        content: await renderTemplate("openclaw.config.json.template", {
          ...config,
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, stateDir }) => ({
      HOME: homeDir,
      OPENCLAW_CONFIG_PATH: resolve(homeDir, ".openclaw", "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
      NODE_ENV: "production",
      NO_COLOR: "1",
      CI: "1",
      TERM: "dumb",
    }),
    start: ({ binaryPath, homeDir, stateDir }) => {
      const port = 28789
      return Promise.resolve({
        command: binaryPath,
        args: ["gateway", "run", "--port", String(port), "--allow-unconfigured", "--force"],
        env: {
          HOME: homeDir,
          OPENCLAW_CONFIG_PATH: resolve(homeDir, ".openclaw", "openclaw.json"),
          OPENCLAW_STATE_DIR: stateDir,
          NODE_ENV: "production",
          NO_COLOR: "1",
          CI: "1",
          TERM: "dumb",
        },
        port,
      })
    },
    status: async ({ binaryPath, homeDir, port, stateDir }) => {
      if (port === undefined) {
        return false
      }
      const child = Bun.spawn(
        [binaryPath, "gateway", "health", "--url", `ws://127.0.0.1:${port}`, "--json", "--no-color"],
        {
          env: {
            ...process.env,
            HOME: homeDir,
            OPENCLAW_STATE_DIR: stateDir,
          },
          stderr: "ignore",
          stdout: "pipe",
        },
      )
      const exitCode = await child.exited
      return exitCode === 0
    },
  },
} satisfies AdapterRegistration

const nanobotRegistration = {
  manifest: {
    id: "nanobot",
    displayName: "Nanobot",
    supportTier: "tier2",
    description: "Package-managed local adapter with native daemon supervision",
    repository: "https://github.com/nanobot-ai/nanobot",
    docsUrl: "https://github.com/nanobot-ai/nanobot",
    capabilities: makeCapabilities(),
    config: makeConfig([
      {
        path: ".nanobot/config.json",
        format: "json",
        template: { kind: "file", path: resolve(templateDir, "nanobot.config.json.template") },
        requiredKeys: [...sharedKeys],
      },
    ]),
    backends: [
      {
        kind: "local",
        supported: true,
        install: [
          {
            strategy: "python-package",
            priority: 1,
            packageName: "nanobot-ai",
            installer: "uv-tool",
            entrypoint: "nanobot",
            versionSource: { kind: "pypi", packageName: "nanobot-ai" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeNativeDaemonRuntime(),
      },
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, homeDir, message }) => [
      binaryPath,
      "--config",
      resolve(homeDir, ".nanobot", "config.json"),
      "call",
      "defaults",
      message,
    ],
    renderConfig: async ({ config, workspaceDir }) => [
      {
        path: ".nanobot/config.json",
        content: await renderTemplate("nanobot.config.json.template", {
          ...config,
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot }) => ({
      HOME: homeDir,
      CLAWCTL_INSTALL_ROOT: installRoot,
      NO_COLOR: "1",
    }),
    start: ({ binaryPath, homeDir, installRoot }) => {
      const port = 28080
      return Promise.resolve({
        command: binaryPath,
        args: [
          "--config",
          resolve(homeDir, ".nanobot", "config.json"),
          "run",
          "--listen-address",
          `127.0.0.1:${port}`,
          "--disable-ui",
          "--healthz-path",
          "/healthz",
          "--agent",
          "defaults",
        ],
        env: {
          HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          NO_COLOR: "1",
        },
        port,
      })
    },
    status: async ({ port }) => {
      if (port === undefined) {
        return false
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`)
        return response.ok
      } catch {
        return false
      }
    },
  },
} satisfies AdapterRegistration

const nanoclawRegistration = {
  manifest: {
    id: "nanoclaw",
    displayName: "NanoClaw",
    supportTier: "tier3",
    description: "Bootstrap-heavy local install with native daemon supervision",
    repository: "https://github.com/qwibitai/nanoclaw",
    docsUrl: "https://github.com/qwibitai/nanoclaw",
    capabilities: makeCapabilities({
      chat: false,
      ping: false,
      telegram: true,
    }),
    config: makeConfig([], []),
    backends: [
      {
        kind: "local",
        supported: true,
        install: [
          {
            strategy: "repo-bootstrap",
            priority: 1,
            repository: "https://github.com/qwibitai/nanoclaw.git",
            refPolicy: "branch",
            bootstrapHook: "install",
            versionSource: { kind: "adapter-hook", hook: "resolveVersions" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeNativeDaemonRuntime(),
      },
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    install: true,
    resolveVersions: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: () => [],
    install: async ({ installRoot }) => {
      const repoDir = resolve(installRoot, "repo")
      const install = Bun.spawn([process.env.CLAWCTL_NPM_BIN ?? "npm", "ci"], {
        cwd: repoDir,
        env: process.env,
        stderr: "inherit",
        stdout: "inherit",
      })
      if ((await install.exited) !== 0) {
        throw new Error("nanoclaw bootstrap failed during npm ci")
      }
      const build = Bun.spawn([process.env.CLAWCTL_NPM_BIN ?? "npm", "run", "build"], {
        cwd: repoDir,
        env: process.env,
        stderr: "inherit",
        stdout: "inherit",
      })
      if ((await build.exited) !== 0) {
        throw new Error("nanoclaw bootstrap failed during npm run build")
      }
      return {
        entrypointCommand: ["node", resolve(repoDir, "dist", "index.js")],
      }
    },
    resolveVersions: async () => ["main"],
    renderConfig: async () => [],
    runtimeEnv: ({ homeDir, installRoot }) => ({
      HOME: homeDir,
      CLAWCTL_INSTALL_ROOT: installRoot,
      NO_COLOR: "1",
      CI: "1",
    }),
    start: ({ installRoot, homeDir, runtimeDir, stateDir, workspaceDir }) =>
      Promise.resolve({
        command: "node",
        args: [resolve(installRoot, "repo", "dist", "index.js")],
        env: {
          HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
          CLAWCTL_WORKSPACE_DIR: workspaceDir,
          NO_COLOR: "1",
          CI: "1",
        },
      }),
    status: ({ installRoot }) => {
      return Promise.resolve(existsSync(resolve(installRoot, "repo", "data", "ipc")))
    },
  },
} satisfies AdapterRegistration

const bitclawRegistration = {
  manifest: {
    id: "bitclaw",
    displayName: "BitClaw",
    supportTier: "tier3",
    description: "Bootstrap-heavy local install with native daemon supervision",
    repository: "https://github.com/NickTikhonov/bitclaw",
    docsUrl: "https://github.com/NickTikhonov/bitclaw",
    capabilities: makeCapabilities({
      chat: false,
      ping: false,
      telegram: true,
    }),
    config: makeConfig([], []),
    backends: [
      {
        kind: "local",
        supported: true,
        install: [
          {
            strategy: "repo-bootstrap",
            priority: 1,
            repository: "https://github.com/NickTikhonov/bitclaw.git",
            refPolicy: "branch",
            bootstrapHook: "install",
            versionSource: { kind: "adapter-hook", hook: "resolveVersions" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeNativeDaemonRuntime(),
      },
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    install: true,
    resolveVersions: true,
    renderConfig: true,
    start: true,
    status: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: () => [],
    install: async ({ installRoot }) => {
      const repoDir = resolve(installRoot, "repo")
      const install = Bun.spawn([process.env.CLAWCTL_NPM_BIN ?? "npm", "ci"], {
        cwd: repoDir,
        env: process.env,
        stderr: "inherit",
        stdout: "inherit",
      })
      if ((await install.exited) !== 0) {
        throw new Error("bitclaw bootstrap failed during npm ci")
      }
      return {
        entrypointCommand: ["node", resolve(repoDir, "node_modules", "tsx", "dist", "cli.mjs")],
      }
    },
    resolveVersions: async () => ["main"],
    renderConfig: async () => [],
    runtimeEnv: ({ homeDir, installRoot }) => ({
      HOME: homeDir,
      BITCLAW_HOME: homeDir,
      CLAWCTL_INSTALL_ROOT: installRoot,
      NO_COLOR: "1",
      CI: "1",
    }),
    start: ({ installRoot, homeDir, runtimeDir, stateDir, workspaceDir }) =>
      Promise.resolve({
        command: "node",
        args: [resolve(installRoot, "repo", "node_modules", "tsx", "dist", "cli.mjs"), "src/main.ts"],
        env: {
          HOME: homeDir,
          BITCLAW_HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
          CLAWCTL_WORKSPACE_DIR: workspaceDir,
          NO_COLOR: "1",
          CI: "1",
        },
      }),
    status: ({ homeDir }) => {
      const ipcDir = resolve(homeDir, "ipc")
      const inboundDir = resolve(ipcDir, "inbound")
      const outboundDir = resolve(ipcDir, "outbound")
      return Promise.resolve(existsSync(inboundDir) && existsSync(outboundDir))
    },
  },
} satisfies AdapterRegistration

const ironclawRegistration = makeReleaseInstallOnlyRegistration({
  id: "ironclaw",
  displayName: "IronClaw",
  description: "Experimental PostgreSQL-backed Rust agent platform",
  repository: "nearai/ironclaw",
  docsUrl: "https://github.com/nearai/ironclaw",
  assetPattern: "ironclaw-aarch64-apple-darwin.tar.gz",
  assetArchive: { kind: "tar.gz", binaryPath: "ironclaw" },
})

const piclawRegistration = {
  manifest: {
    id: "piclaw",
    displayName: "Piclaw",
    supportTier: "tier3",
    description: "Docker-first web orchestrator",
    repository: "https://github.com/rcarmo/piclaw",
    docsUrl: "https://github.com/rcarmo/piclaw",
    capabilities: makeCapabilities({
      chat: false,
      ping: false,
      status: true,
      local: false,
      docker: true,
    }),
    config: makeConfig([], []),
    backends: [
      {
        kind: "local",
        supported: false,
        install: [],
        runtime: makeUnmanagedRuntime(),
      },
      {
        kind: "docker",
        supported: true,
        install: [
          {
            strategy: "docker-build",
            priority: 1,
            context: "https://github.com/rcarmo/piclaw.git",
            image: "piclaw",
            versionSource: { kind: "git-tags", repository: "https://github.com/rcarmo/piclaw.git" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeUnmanagedRuntime(),
      },
    ],
  } satisfies ImplementationManifest,
  ...makeInstallOnlyHooks(),
} satisfies AdapterRegistration

export const adapterRegistrations = [
  nullclawRegistration,
  picoclawRegistration,
  zeroclawRegistration,
  openclawRegistration,
  nanobotRegistration,
  nanoclawRegistration,
  bitclawRegistration,
  ironclawRegistration,
  piclawRegistration,
] as const

export function listRegisteredImplementations(): RegisteredImplementation[] {
  return [...adapterRegistrations]
}

export function getRegisteredImplementation(id: string): AdapterRegistration {
  const registration = adapterRegistrations.find((item) => item.manifest.id === id)
  if (!registration) {
    throw new Error(`unsupported implementation: ${id}`)
  }
  return registration
}

export function getBackendManifest(id: string, kind: BackendManifest["kind"]): BackendManifest | undefined {
  return getRegisteredImplementation(id).manifest.backends.find((backend) => backend.kind === kind)
}

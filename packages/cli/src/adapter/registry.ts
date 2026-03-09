import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  AdapterHookReference,
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
  buildChatCommand: (input: { binaryPath: string; message: string }) => string[]
  resolveVersions?: () => Promise<ReadonlyArray<string>>
  renderConfig: (input: { config: Record<string, string>; workspaceDir: string }) => Promise<
    Array<{
      content: string
      path: string
    }>
  >
  normalizeChatOutput?: (input: { stdout: string; stderr: string }) => string
  runtimeEnv: (input: { homeDir: string; runtimeDir: string; workspaceDir: string }) => NodeJS.ProcessEnv
}

type AdapterRegistration = RegisteredImplementation & {
  hooks: {
    buildChatCommand: true
    normalizeChatOutput?: true
    resolveVersions?: true
    renderConfig: true
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
    oneshot: true,
    daemon: false,
    ...overrides,
  }
}

function makeLocalRuntime(entryHook: AdapterHookReference): RuntimeManifest {
  return {
    mode: "oneshot",
    homeStrategy: "isolated-home",
    workspaceStrategy: "per-runtime",
    entrypoint: entryHook,
    health: { kind: "none" },
    chat: entryHook,
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

function makeExternalRuntime(): RuntimeManifest {
  return {
    mode: "external",
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

function makeBootstrapRegistration(input: {
  description: string
  displayName: string
  docsUrl: string
  id: string
  repository: string
}): AdapterRegistration {
  return {
    manifest: {
      id: input.id,
      displayName: input.displayName,
      supportTier: "tier3",
      description: input.description,
      repository: input.repository.replace(/\.git$/u, ""),
      docsUrl: input.docsUrl,
      capabilities: makeCapabilities({
        chat: false,
        ping: false,
        telegram: true,
        oneshot: false,
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
              repository: input.repository,
              refPolicy: "branch",
              bootstrapHook: "install",
              versionSource: { kind: "adapter-hook", hook: "resolveVersions" },
              supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
            },
          ],
          runtime: makeExternalRuntime(),
        },
      ],
    },
    ...makeInstallOnlyHooks(),
  } satisfies AdapterRegistration
}

const nullclawRegistration = {
  manifest: {
    id: "nullclaw",
    displayName: "NullClaw",
    supportTier: "tier1",
    description: "Release-backed one-shot local CLI install",
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
        makeLocalRuntime({ kind: "adapter-hook", hook: "chat" }),
      ),
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
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
    runtimeEnv: ({ homeDir, workspaceDir }) => ({
      HOME: homeDir,
      NULLCLAW_HOME: resolve(homeDir, ".nullclaw"),
      NULLCLAW_WORKSPACE: workspaceDir,
    }),
  },
} satisfies AdapterRegistration

const picoclawRegistration = {
  manifest: {
    id: "picoclaw",
    displayName: "PicoClaw",
    supportTier: "tier1",
    description: "Release-backed one-shot local CLI install",
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
        makeLocalRuntime({ kind: "adapter-hook", hook: "chat" }),
      ),
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
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
    runtimeEnv: ({ homeDir }) => ({
      HOME: homeDir,
      PICOCLAW_HOME: homeDir,
    }),
  },
} satisfies AdapterRegistration

const zeroclawRegistration = {
  manifest: {
    id: "zeroclaw",
    displayName: "ZeroClaw",
    supportTier: "tier1",
    description: "Release-backed one-shot local CLI install",
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
        makeLocalRuntime({ kind: "adapter-hook", hook: "chat" }),
      ),
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
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
    runtimeEnv: ({ homeDir }) => ({
      HOME: homeDir,
    }),
  },
} satisfies AdapterRegistration

const openclawRegistration = {
  manifest: {
    id: "openclaw",
    displayName: "OpenClaw",
    supportTier: "tier2",
    description: "Package-managed one-shot local CLI install",
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
        runtime: makeLocalRuntime({ kind: "adapter-hook", hook: "chat" }),
      },
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    normalizeChatOutput: true,
    renderConfig: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, message }) => [
      binaryPath,
      "--no-color",
      "agent",
      "--local",
      "--json",
      "--session-id",
      "clawctl",
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
    runtimeEnv: ({ homeDir, runtimeDir }) => ({
      HOME: homeDir,
      OPENCLAW_CONFIG_PATH: resolve(homeDir, ".openclaw", "openclaw.json"),
      OPENCLAW_STATE_DIR: resolve(runtimeDir, "state"),
      NODE_ENV: "production",
      NO_COLOR: "1",
      CI: "1",
      TERM: "dumb",
    }),
  },
} satisfies AdapterRegistration

const nanobotRegistration = {
  manifest: {
    id: "nanobot",
    displayName: "Nanobot",
    supportTier: "tier2",
    description: "Package-managed one-shot local CLI install",
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
        runtime: makeLocalRuntime({ kind: "adapter-hook", hook: "chat" }),
      },
    ],
  } satisfies ImplementationManifest,
  hooks: {
    buildChatCommand: true,
    renderConfig: true,
    runtimeEnv: true,
  },
  implementationHooks: {
    buildChatCommand: ({ binaryPath, message }) => [
      binaryPath,
      "agent",
      "--config",
      ".nanobot/config.json",
      "--workspace",
      ".",
      "--session",
      "clawctl",
      "--message",
      message,
      "--no-markdown",
      "--no-logs",
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
    runtimeEnv: ({ homeDir }) => ({
      HOME: homeDir,
      PYTHONUNBUFFERED: "1",
    }),
  },
} satisfies AdapterRegistration

const nanoclawRegistration = makeBootstrapRegistration({
  id: "nanoclaw",
  displayName: "NanoClaw",
  description: "Experimental bootstrap-heavy local install",
  repository: "https://github.com/qwibitai/nanoclaw.git",
  docsUrl: "https://github.com/qwibitai/nanoclaw",
})

const bitclawRegistration = makeBootstrapRegistration({
  id: "bitclaw",
  displayName: "BitClaw",
  description: "Experimental bootstrap-heavy local install",
  repository: "https://github.com/NickTikhonov/bitclaw.git",
  docsUrl: "https://github.com/NickTikhonov/bitclaw",
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
      oneshot: false,
    }),
    config: makeConfig([], []),
    backends: [
      {
        kind: "local",
        supported: false,
        install: [],
        runtime: makeExternalRuntime(),
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
        runtime: makeExternalRuntime(),
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

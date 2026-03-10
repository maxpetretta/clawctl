import { existsSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gitExecutable, npmExecutable, uvExecutable } from "../tooling.ts"
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
    backend: "local" | "docker"
    binaryPath: string
    config: Record<string, string>
    entrypointCommand: ReadonlyArray<string>
    installRoot: string
    homeDir: string
    message: string
    port?: number
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => string[]
  buildShimCommand?: (input: {
    backend: "local" | "docker"
    binaryPath: string
    config: Record<string, string>
    entrypointCommand: ReadonlyArray<string>
    installRoot: string
    homeDir: string
    port?: number
    runtimeDir: string
    stateDir: string
    workspaceDir: string
    args: ReadonlyArray<string>
  }) => string[]
  chat?: (input: {
    backend: "local" | "docker"
    binaryPath: string
    config: Record<string, string>
    entrypointCommand: ReadonlyArray<string>
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
    backend: "local" | "docker"
    binaryPath: string
    config: Record<string, string>
    entrypointCommand: ReadonlyArray<string>
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
    backend: "local" | "docker"
    binaryPath: string
    config: Record<string, string>
    entrypointCommand: ReadonlyArray<string>
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
    backend: "local" | "docker"
    config: Record<string, string>
    homeDir: string
    entrypointCommand: ReadonlyArray<string>
    installRoot: string
    port?: number
    runtimeDir: string
    stateDir: string
    workspaceDir: string
  }) => NodeJS.ProcessEnv
}

type AdapterRegistration = RegisteredImplementation & {
  messagingUnavailableReason?: string
  hooks: {
    buildChatCommand: true
    buildShimCommand?: true
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

type RuntimeEnvInput = Parameters<ImplementationHook["runtimeEnv"]>[0]
type StartInput = Parameters<NonNullable<ImplementationHook["start"]>>[0]
type StartResult = Awaited<ReturnType<NonNullable<ImplementationHook["start"]>>>
type StatusInput = Parameters<NonNullable<ImplementationHook["status"]>>[0]

const currentDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(currentDir, "../..")
const dockerContextDir = resolve(packageDir, "docker")
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

function makeManagedContainerRuntime(): RuntimeManifest {
  return {
    supervision: { kind: "proxy" },
    homeStrategy: "isolated-home",
    workspaceStrategy: "per-runtime",
    entrypoint: { kind: "adapter-hook", hook: "start" },
    health: { kind: "process" },
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

function parseSharedList(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith("@") ? entry.slice(1) : entry))
}

function resolveTelegramSettings(config: Record<string, string>) {
  const token = config.TELEGRAM_BOT_TOKEN?.trim() ?? ""
  const username = config.TELEGRAM_BOT_USERNAME?.trim() ?? ""
  const chatId = config.TELEGRAM_CHAT_ID?.trim() ?? ""
  const allowedFrom = parseSharedList(config.TELEGRAM_ALLOWED_FROM)
  const identities = allowedFrom.length > 0 ? allowedFrom : parseSharedList(chatId)
  return {
    enabled: token.length > 0,
    token,
    username: username.startsWith("@") ? username.slice(1) : username,
    chatId: chatId.length > 0 ? chatId : (identities[0] ?? ""),
    identities,
  }
}

function nullclawTelegramSuffix(config: Record<string, string>): string {
  const telegram = resolveTelegramSettings(config)
  if (!telegram.enabled) {
    return ""
  }
  return `,
    "telegram": {
      "accounts": {
        "default": {
          "bot_token": ${JSON.stringify(telegram.token)},
          "allow_from": ${JSON.stringify(telegram.identities)}
        }
      }
    }`
}

function picoclawTelegramBlock(config: Record<string, string>): string {
  const telegram = resolveTelegramSettings(config)
  if (!telegram.enabled) {
    return `{
      "enabled": false,
      "token": "",
      "allow_from": []
    }`
  }
  return `{
      "enabled": true,
      "token": ${JSON.stringify(telegram.token)},
      "allow_from": ${JSON.stringify(telegram.identities)}
    }`
}

const picoclawKnownModelVendors = new Set([
  "openai",
  "anthropic",
  "zhipu",
  "deepseek",
  "gemini",
  "groq",
  "moonshot",
  "qwen",
  "nvidia",
  "ollama",
  "openrouter",
  "litellm",
  "vllm",
  "cerebras",
  "volcengine",
  "shengsuanyun",
  "vivgrid",
  "antigravity",
  "github-copilot",
])

function picoclawModelId(config: Record<string, string>): string {
  const rawModel = config.CLAW_MODEL?.trim() ?? ""
  if (!rawModel) {
    return rawModel
  }

  const vendorCandidate = rawModel.split("/", 1)[0]
  if (vendorCandidate && picoclawKnownModelVendors.has(vendorCandidate)) {
    return rawModel
  }

  const rawBaseUrl = config.CLAW_BASE_URL?.trim()
  if (rawBaseUrl) {
    try {
      const url = new URL(rawBaseUrl)
      const host = url.hostname.toLowerCase()
      if (host === "openrouter.ai") {
        return `openrouter/${rawModel}`
      }
      if (host === "api.openai.com") {
        return `openai/${rawModel}`
      }
      if (host === "open.bigmodel.cn") {
        return `zhipu/${rawModel}`
      }
      if (host === "api.deepseek.com") {
        return `deepseek/${rawModel}`
      }
      if (host === "generativelanguage.googleapis.com") {
        return `gemini/${rawModel}`
      }
      if (host === "api.groq.com") {
        return `groq/${rawModel}`
      }
      if (host === "api.moonshot.cn") {
        return `moonshot/${rawModel}`
      }
      if (host === "dashscope.aliyuncs.com") {
        return `qwen/${rawModel}`
      }
      if (host === "integrate.api.nvidia.com") {
        return `nvidia/${rawModel}`
      }
      if (host === "localhost" || host === "127.0.0.1") {
        if (url.port === "11434") {
          return `ollama/${rawModel}`
        }
        if (url.port === "4000") {
          return `litellm/${rawModel}`
        }
        if (url.port === "8000") {
          return `vllm/${rawModel}`
        }
      }
    } catch {
      return `openai/${rawModel}`
    }
  }

  return `openai/${rawModel}`
}

function zeroclawTelegramBlock(config: Record<string, string>): string {
  const telegram = resolveTelegramSettings(config)
  if (!telegram.enabled) {
    return ""
  }
  return `

[channels_config.telegram]
bot_token = ${JSON.stringify(telegram.token)}
allowed_users = ${JSON.stringify(telegram.identities)}
interrupt_on_new_message = false
`
}

function openclawTelegramChannelsBlock(config: Record<string, string>): string {
  const telegram = resolveTelegramSettings(config)
  if (!telegram.enabled) {
    return ""
  }
  return `,
  "channels": {
    "telegram": {
      "enabled": true,
      "configWrites": false,
      "dmPolicy": "pairing",
      "botToken": ${JSON.stringify(telegram.token)},
      "groupPolicy": "disabled",
      "streaming": "partial"
    }
  }`
}

function openclawTelegramCredentialFiles(config: Record<string, string>) {
  const telegram = resolveTelegramSettings(config)
  if (!telegram.enabled || telegram.identities.length === 0) {
    return [] as Array<{ path: string; content: string }>
  }
  const content = JSON.stringify({ version: 1, allowFrom: telegram.identities }, null, 2)
  return [
    {
      path: ".openclaw/credentials/telegram-allowFrom.json",
      content,
    },
    {
      path: ".openclaw/credentials/telegram-default-allowFrom.json",
      content,
    },
  ]
}

function portAcceptsConnections(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port })
    let settled = false
    const finish = (value: boolean) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolvePromise(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

function resolvedStart(result: StartResult): Promise<StartResult> {
  return Promise.resolve(result)
}

function clawctlRuntimeEnv(
  input: Pick<RuntimeEnvInput, "homeDir" | "installRoot">,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    HOME: input.homeDir,
    CLAWCTL_INSTALL_ROOT: input.installRoot,
    ...extra,
  }
}

function managedDaemonEnv(
  input: Pick<StartInput, "homeDir" | "installRoot" | "runtimeDir" | "stateDir">,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...clawctlRuntimeEnv(input, extra),
    CLAWCTL_RUNTIME_DIR: input.runtimeDir,
    CLAWCTL_STATE_DIR: input.stateDir,
  }
}

function spawnExitCodeIsZero(command: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      ...env,
    },
    stderr: "ignore",
    stdout: "ignore",
  })
  return child.exited.then((exitCode) => exitCode === 0)
}

function makeBinaryStatusHook(
  build: (input: StatusInput) => { command: string[]; env: NodeJS.ProcessEnv },
): NonNullable<ImplementationHook["status"]> {
  return (input) => {
    const { command, env } = build(input)
    return spawnExitCodeIsZero(command, env)
  }
}

function makePortStatusHook(options?: {
  readonly checkConnections?: boolean
}): NonNullable<ImplementationHook["status"]> {
  return ({ port }) =>
    Promise.resolve(
      port === undefined ? false : options?.checkConnections === true ? portAcceptsConnections(port) : true,
    )
}

async function runInheritedCommand(
  command: string[],
  options: {
    readonly allowFailure?: boolean
    readonly cwd?: string
    readonly failureMessage: string
  },
): Promise<void> {
  const child = Bun.spawn(command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0 && options.allowFailure !== true) {
    throw new Error(options.failureMessage)
  }
}

function makeReleaseBackend(input: BackendManifest["install"][number], runtime: RuntimeManifest): BackendManifest {
  return {
    kind: "local",
    supported: true,
    install: [input],
    runtime,
  }
}

function makeDockerBackend(input: BackendManifest["install"][number], runtime: RuntimeManifest): BackendManifest {
  return {
    kind: "docker",
    supported: true,
    install: [input],
    runtime,
  }
}

export function isInstallOnlyRegistration(registration: RegisteredImplementation): boolean {
  return registration.manifest.backends.every(
    (backend) => !backend.supported || backend.runtime.supervision.kind === "unmanaged",
  )
}

export function installOnlyInteractionMessage(implementation: string): string {
  return `${implementation} is install-only in clawctl; it is not interactable or executable`
}

function hermesEnvFile(config: Record<string, string>, workspaceDir: string): string {
  const telegram = resolveTelegramSettings(config)
  return [
    `OPENAI_BASE_URL=${config.CLAW_BASE_URL}`,
    `OPENAI_API_KEY=${config.CLAW_API_KEY}`,
    `LLM_MODEL=${config.CLAW_MODEL}`,
    `OPENAI_MODEL=${config.CLAW_MODEL}`,
    `TERMINAL_CWD=${workspaceDir}`,
    ...(telegram.enabled ? [`TELEGRAM_BOT_TOKEN=${telegram.token}`] : []),
    ...(telegram.username ? [`TELEGRAM_BOT_USERNAME=${telegram.username}`] : []),
    ...(telegram.chatId ? [`TELEGRAM_CHAT_ID=${telegram.chatId}`] : []),
    ...(telegram.identities.length > 0 ? [`TELEGRAM_ALLOWED_FROM=${telegram.identities.join(",")}`] : []),
    "",
  ].join("\n")
}

function hermesRuntimeEnv(input: { homeDir: string; installRoot: string; workspaceDir: string }): NodeJS.ProcessEnv {
  return {
    HOME: input.homeDir,
    HERMES_HOME: input.homeDir,
    CLAWCTL_INSTALL_ROOT: input.installRoot,
    TERMINAL_CWD: input.workspaceDir,
    MSWEA_GLOBAL_CONFIG_DIR: input.homeDir,
    MSWEA_SILENT_STARTUP: "1",
    HERMES_QUIET: "1",
    NO_COLOR: "1",
    CI: "1",
    PATH: [
      resolve(input.installRoot, "repo", "venv", "bin"),
      resolve(input.installRoot, "repo", "node_modules", ".bin"),
      process.env.PATH ?? "",
    ]
      .filter((entry) => entry.length > 0)
      .join(":"),
  }
}

function hermesDockerRuntimeEnv(input: { homeDir: string; workspaceDir: string }): NodeJS.ProcessEnv {
  return {
    HOME: input.homeDir,
    HERMES_HOME: input.homeDir,
    TERMINAL_CWD: input.workspaceDir,
    MSWEA_GLOBAL_CONFIG_DIR: input.homeDir,
    MSWEA_SILENT_STARTUP: "1",
    HERMES_QUIET: "1",
    NO_COLOR: "1",
    CI: "1",
    PATH: ["/opt/hermes/venv/bin", "/opt/hermes/repo/node_modules/.bin", process.env.PATH ?? ""]
      .filter((entry) => entry.length > 0)
      .join(":"),
  }
}

const nullclawRegistration = {
  manifest: {
    id: "nullclaw",
    displayName: "NullClaw",
    supportTier: "tier1",
    description: "Release-backed local adapter with native daemon supervision",
    repository: "https://github.com/nullclaw/nullclaw",
    docsUrl: "https://github.com/nullclaw/nullclaw",
    capabilities: makeCapabilities({
      docker: true,
      telegram: true,
    }),
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
      makeDockerBackend(
        {
          strategy: "docker-build",
          priority: 2,
          context: resolve(dockerContextDir, "nullclaw"),
          image: "clawctl/nullclaw",
          entrypointCommand: ["nullclaw"],
          versionSource: { kind: "github-releases", repository: "nullclaw/nullclaw" },
          supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        },
        makeManagedContainerRuntime(),
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
          NULLCLAW_TELEGRAM_SUFFIX: nullclawTelegramSuffix(config),
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot }) => clawctlRuntimeEnv({ homeDir, installRoot }),
    start: ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) =>
      resolvedStart({
        command: binaryPath,
        args: ["gateway"],
        env: managedDaemonEnv({ homeDir, installRoot, runtimeDir, stateDir }),
      }),
    status: makeBinaryStatusHook(({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) => ({
      command: [binaryPath, "status"],
      env: managedDaemonEnv({ homeDir, installRoot, runtimeDir, stateDir }),
    })),
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
    capabilities: makeCapabilities({
      docker: true,
      telegram: true,
    }),
    config: makeConfig([
      {
        path: "config.json",
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
      makeDockerBackend(
        {
          strategy: "docker-build",
          priority: 2,
          context: resolve(dockerContextDir, "picoclaw"),
          image: "clawctl/picoclaw",
          entrypointCommand: ["picoclaw"],
          versionSource: { kind: "github-releases", repository: "sipeed/picoclaw" },
          supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        },
        makeManagedContainerRuntime(),
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
        path: "config.json",
        content: await renderTemplate("picoclaw.config.json.template", {
          ...config,
          PICOCLAW_MODEL: picoclawModelId(config),
          PICOCLAW_TELEGRAM_BLOCK: picoclawTelegramBlock(config),
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot }) => clawctlRuntimeEnv({ homeDir, installRoot }, { PICOCLAW_HOME: homeDir }),
    start: ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) =>
      resolvedStart({
        command: binaryPath,
        args: ["gateway"],
        env: managedDaemonEnv({ homeDir, installRoot, runtimeDir, stateDir }, { PICOCLAW_HOME: homeDir }),
      }),
    status: makeBinaryStatusHook(({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) => ({
      command: [binaryPath, "status"],
      env: managedDaemonEnv({ homeDir, installRoot, runtimeDir, stateDir }, { PICOCLAW_HOME: homeDir }),
    })),
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
    capabilities: makeCapabilities({
      docker: true,
      telegram: true,
    }),
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
      makeDockerBackend(
        {
          strategy: "docker-build",
          priority: 2,
          context: resolve(dockerContextDir, "zeroclaw"),
          image: "clawctl/zeroclaw",
          entrypointCommand: ["zeroclaw"],
          versionSource: { kind: "github-releases", repository: "zeroclaw-labs/zeroclaw" },
          supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        },
        makeManagedContainerRuntime(),
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
          ZEROCLAW_TELEGRAM_BLOCK: zeroclawTelegramBlock(config),
          WORKSPACE_DIR: workspaceDir,
        }),
      },
    ],
    runtimeEnv: ({ homeDir, installRoot }) => clawctlRuntimeEnv({ homeDir, installRoot }),
    start: ({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) =>
      resolvedStart({
        command: binaryPath,
        args: ["daemon"],
        env: managedDaemonEnv({ homeDir, installRoot, runtimeDir, stateDir }),
      }),
    status: makeBinaryStatusHook(({ binaryPath, homeDir, installRoot, runtimeDir, stateDir }) => ({
      command: [binaryPath, "status"],
      env: managedDaemonEnv({ homeDir, installRoot, runtimeDir, stateDir }),
    })),
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
    capabilities: makeCapabilities({
      docker: true,
      telegram: true,
    }),
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
      {
        kind: "docker",
        supported: true,
        install: [
          {
            strategy: "docker-build",
            priority: 2,
            context: resolve(dockerContextDir, "openclaw"),
            image: "clawctl/openclaw",
            entrypointCommand: ["openclaw"],
            versionSource: { kind: "npm", packageName: "openclaw" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeManagedContainerRuntime(),
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
          OPENCLAW_TELEGRAM_CHANNELS_BLOCK: openclawTelegramChannelsBlock(config),
          WORKSPACE_DIR: workspaceDir,
        }),
      },
      ...openclawTelegramCredentialFiles(config),
    ],
    runtimeEnv: ({ homeDir, stateDir }) => ({
      HOME: homeDir,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_CONFIG_PATH: resolve(homeDir, ".openclaw", "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
      NODE_ENV: "production",
      NO_COLOR: "1",
      CI: "1",
      TERM: "dumb",
    }),
    start: ({ binaryPath, homeDir, stateDir }) => {
      const port = 28789
      return resolvedStart({
        command: binaryPath,
        args: ["gateway", "run", "--port", String(port), "--allow-unconfigured", "--force"],
        env: {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
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
    status: makePortStatusHook({ checkConnections: true }),
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
    capabilities: makeCapabilities({
      docker: true,
    }),
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
      {
        kind: "docker",
        supported: true,
        install: [
          {
            strategy: "docker-build",
            priority: 2,
            context: resolve(dockerContextDir, "nanobot"),
            image: "clawctl/nanobot",
            entrypointCommand: ["nanobot"],
            versionSource: { kind: "pypi", packageName: "nanobot-ai" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeManagedContainerRuntime(),
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
    buildChatCommand: ({ binaryPath, homeDir, message, workspaceDir }) => [
      binaryPath,
      "agent",
      "--config",
      resolve(homeDir, ".nanobot", "config.json"),
      "--workspace",
      workspaceDir,
      "--message",
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
    runtimeEnv: ({ homeDir, installRoot }) => clawctlRuntimeEnv({ homeDir, installRoot }, { NO_COLOR: "1" }),
    start: ({ binaryPath, homeDir, installRoot, workspaceDir }) => {
      const port = 28080
      return resolvedStart({
        command: binaryPath,
        args: [
          "gateway",
          "--config",
          resolve(homeDir, ".nanobot", "config.json"),
          "--workspace",
          workspaceDir,
          "--port",
          `${port}`,
        ],
        env: {
          HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          NO_COLOR: "1",
        },
        port,
      })
    },
    status: makePortStatusHook(),
  },
} satisfies AdapterRegistration

const hermesRegistration = {
  manifest: {
    id: "hermes",
    displayName: "Hermes",
    supportTier: "tier3",
    description: "Bootstrap-heavy local adapter with native gateway supervision",
    repository: "https://github.com/NousResearch/hermes-agent",
    docsUrl: "https://hermes-agent.nousresearch.com/docs/",
    capabilities: makeCapabilities({
      docker: true,
      telegram: true,
    }),
    config: makeConfig([
      {
        path: ".env",
        format: "env",
        template: { kind: "inline", value: "" },
        requiredKeys: [...sharedKeys],
      },
    ]),
    backends: [
      {
        kind: "local",
        supported: true,
        install: [
          {
            strategy: "repo-bootstrap",
            priority: 1,
            repository: "https://github.com/NousResearch/hermes-agent.git",
            refPolicy: "branch",
            bootstrapHook: "install",
            versionSource: { kind: "adapter-hook", hook: "resolveVersions" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeNativeDaemonRuntime(),
      },
      {
        kind: "docker",
        supported: true,
        install: [
          {
            strategy: "docker-build",
            priority: 2,
            context: resolve(dockerContextDir, "hermes"),
            image: "clawctl/hermes",
            entrypointCommand: ["/usr/local/bin/hermes"],
            versionSource: { kind: "adapter-hook", hook: "resolveVersions" },
            supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
          },
        ],
        runtime: makeManagedContainerRuntime(),
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
    buildChatCommand: ({ backend, binaryPath, installRoot, message }) =>
      backend === "docker"
        ? ["/opt/hermes/venv/bin/python", "/opt/hermes/clawctl-hermes-chat.py", message]
        : [binaryPath, resolve(installRoot, "clawctl-hermes-chat.py"), message],
    install: async ({ installRoot }) => {
      const repoDir = resolve(installRoot, "repo")
      const git = gitExecutable()
      const uv = uvExecutable()
      const npm = npmExecutable()
      const pythonBin = resolve(repoDir, "venv", "bin", "python")
      const chatHelper = resolve(installRoot, "clawctl-hermes-chat.py")

      await runInheritedCommand([git, "-C", repoDir, "submodule", "update", "--init", "--recursive"], {
        cwd: repoDir,
        failureMessage: "hermes bootstrap failed during git submodule update",
      })
      await runInheritedCommand([uv, "venv", "venv", "--python", "3.11"], {
        cwd: repoDir,
        failureMessage: "hermes bootstrap failed during uv venv",
      })

      try {
        await runInheritedCommand([uv, "pip", "install", "--python", pythonBin, "-e", ".[all]"], {
          cwd: repoDir,
          failureMessage: "hermes bootstrap failed during uv pip install -e .[all]",
        })
      } catch {
        await runInheritedCommand([uv, "pip", "install", "--python", pythonBin, "-e", "."], {
          cwd: repoDir,
          failureMessage: "hermes bootstrap failed during uv pip install -e .",
        })
      }

      for (const submoduleDir of ["mini-swe-agent", "tinker-atropos"]) {
        if (existsSync(resolve(repoDir, submoduleDir, "pyproject.toml"))) {
          await runInheritedCommand([uv, "pip", "install", "--python", pythonBin, "-e", `./${submoduleDir}`], {
            cwd: repoDir,
            allowFailure: true,
            failureMessage: `hermes optional submodule install failed: ${submoduleDir}`,
          })
        }
      }

      if (existsSync(resolve(repoDir, "package.json"))) {
        await runInheritedCommand([npm, "install", "--silent"], {
          cwd: repoDir,
          allowFailure: true,
          failureMessage: "hermes optional npm install failed",
        })
      }

      await Bun.write(
        chatHelper,
        `from pathlib import Path
import sys

project_root = Path(__file__).resolve().parent / "repo"
sys.path.insert(0, str(project_root))

from cli import HermesCLI


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: clawctl-hermes-chat.py <message>", file=sys.stderr)
        return 1

    cli = HermesCLI(compact=True, verbose=False)
    if not cli._init_agent():
        return 1

    response = cli.agent.chat(sys.argv[1])
    if not response:
        return 1

    print(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,
      )

      return {
        entrypointCommand: [pythonBin, "-m", "hermes_cli.main"],
      }
    },
    resolveVersions: async () => ["main"],
    renderConfig: async ({ config, workspaceDir }) => [
      {
        path: ".env",
        content: hermesEnvFile(config, workspaceDir),
      },
    ],
    runtimeEnv: ({ backend, homeDir, installRoot, workspaceDir }) =>
      backend === "docker"
        ? hermesDockerRuntimeEnv({
            homeDir,
            workspaceDir,
          })
        : hermesRuntimeEnv({
            homeDir,
            installRoot,
            workspaceDir,
          }),
    start: ({ backend, binaryPath, homeDir, installRoot, workspaceDir }) =>
      resolvedStart({
        command: binaryPath,
        args:
          backend === "docker"
            ? ["gateway", "run", "--replace"]
            : ["-m", "hermes_cli.main", "gateway", "run", "--replace"],
        env:
          backend === "docker"
            ? hermesDockerRuntimeEnv({
                homeDir,
                workspaceDir,
              })
            : hermesRuntimeEnv({
                homeDir,
                installRoot,
                workspaceDir,
              }),
      }),
    status: makeBinaryStatusHook(({ backend, binaryPath, homeDir, installRoot, workspaceDir }) => ({
      command:
        backend === "docker"
          ? [binaryPath, "gateway", "status"]
          : [binaryPath, "-m", "hermes_cli.main", "gateway", "status"],
      env:
        backend === "docker"
          ? hermesDockerRuntimeEnv({
              homeDir,
              workspaceDir,
            })
          : hermesRuntimeEnv({
              homeDir,
              installRoot,
              workspaceDir,
            }),
    })),
  },
} satisfies AdapterRegistration

export const adapterRegistrations = [
  nullclawRegistration,
  picoclawRegistration,
  zeroclawRegistration,
  openclawRegistration,
  nanobotRegistration,
  hermesRegistration,
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

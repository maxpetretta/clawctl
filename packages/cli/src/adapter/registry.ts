import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
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
    config: Record<string, string>
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
    config: Record<string, string>
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
    config: Record<string, string>
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
    config: Record<string, string>
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
    config: Record<string, string>
    homeDir: string
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

function bitclawIpcPaths(homeDir: string) {
  const ipcDir = resolve(homeDir, "ipc")
  return {
    archiveDir: resolve(ipcDir, "archive"),
    inboundDir: resolve(ipcDir, "inbound"),
    outboundDir: resolve(ipcDir, "outbound"),
  }
}

function listSortedJsonFiles(targetDir: string): string[] {
  if (!existsSync(targetDir)) {
    return []
  }
  return readdirSync(targetDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => resolve(targetDir, file))
}

function archiveBitclawFile(archiveDir: string, filePath: string): void {
  mkdirSync(archiveDir, { recursive: true })
  renameSync(filePath, resolve(archiveDir, basename(filePath)))
}

function writeBitclawInboundMessage(homeDir: string, message: string): void {
  const { inboundDir } = bitclawIpcPaths(homeDir)
  mkdirSync(inboundDir, { recursive: true })
  const unixSeconds = Math.floor(Date.now() / 1000)
  const rand7 = Math.random().toString(36).slice(2, 9).padEnd(7, "0").slice(0, 7)
  const fileName = `${unixSeconds}_in_${rand7}.json`
  const finalPath = resolve(inboundDir, fileName)
  const tmpPath = `${finalPath}.tmp`
  writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        type: "messages",
        text: message,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  renameSync(tmpPath, finalPath)
}

function clearBitclawOutbound(homeDir: string): void {
  const { archiveDir, outboundDir } = bitclawIpcPaths(homeDir)
  for (const staleFile of listSortedJsonFiles(outboundDir)) {
    archiveBitclawFile(archiveDir, staleFile)
  }
}

function formatBitclawOutbound(event: Record<string, unknown>): string | undefined {
  if (event.type === "result") {
    const status = String(event.status ?? "unknown")
    if (status === "error") {
      return `[error] ${String(event.error ?? "Unknown error")}`
    }
    return String(event.result ?? "").trimEnd()
  }
  if (event.type === "message") {
    return String(event.text ?? "")
  }
  return undefined
}

async function readBitclawResponse(homeDir: string, timeoutMs = 60_000): Promise<string> {
  const { archiveDir, outboundDir } = bitclawIpcPaths(homeDir)
  const deadline = Date.now() + timeoutMs
  let lastMessage: string | undefined
  while (Date.now() < deadline) {
    const files = listSortedJsonFiles(outboundDir)
    if (files.length === 0) {
      await sleep(200)
      continue
    }

    for (const filePath of files) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>
        const output = formatBitclawOutbound(parsed)
        archiveBitclawFile(archiveDir, filePath)
        if (!output) {
          continue
        }
        if (parsed.type === "result") {
          return output.trim()
        }
        lastMessage = output.trim()
      } catch {
        archiveBitclawFile(archiveDir, filePath)
      }
    }
    if (lastMessage) {
      return lastMessage
    }
    await sleep(200)
  }

  throw new Error("timed out waiting for bitclaw response")
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
    capabilities: makeCapabilities({
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
    capabilities: makeCapabilities({
      telegram: true,
    }),
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
          PICOCLAW_TELEGRAM_BLOCK: picoclawTelegramBlock(config),
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
    capabilities: makeCapabilities({
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
    capabilities: makeCapabilities({
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
  messagingUnavailableReason:
    "nanoclaw does not expose a stable local loopback or host-side chat transport yet; only lifecycle control is available",
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
    runtimeEnv: ({ config, homeDir, installRoot }) => {
      const telegram = resolveTelegramSettings(config)
      return {
        HOME: homeDir,
        CLAWCTL_INSTALL_ROOT: installRoot,
        NO_COLOR: "1",
        CI: "1",
        ...(telegram.enabled ? { TELEGRAM_BOT_TOKEN: telegram.token } : {}),
        ...(telegram.username ? { TELEGRAM_BOT_USERNAME: telegram.username } : {}),
        ...(telegram.chatId ? { TELEGRAM_CHAT_ID: telegram.chatId } : {}),
        ...(telegram.identities.length > 0 ? { TELEGRAM_ALLOWED_FROM: telegram.identities.join(",") } : {}),
      }
    },
    start: ({ config, installRoot, homeDir, runtimeDir, stateDir, workspaceDir }) => {
      const telegram = resolveTelegramSettings(config)
      return Promise.resolve({
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
          ...(telegram.enabled ? { TELEGRAM_BOT_TOKEN: telegram.token } : {}),
          ...(telegram.username ? { TELEGRAM_BOT_USERNAME: telegram.username } : {}),
          ...(telegram.chatId ? { TELEGRAM_CHAT_ID: telegram.chatId } : {}),
          ...(telegram.identities.length > 0 ? { TELEGRAM_ALLOWED_FROM: telegram.identities.join(",") } : {}),
        },
      })
    },
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
    chat: true,
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
      await Bun.write(
        resolve(repoDir, "clawctl-daemon.ts"),
        `import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startContainer, stopContainer } from "./src/runtime.ts";

const projectRoot = dirname(fileURLToPath(import.meta.url));
startContainer(projectRoot);

const shutdown = () => {
  try {
    stopContainer();
  } finally {
    process.exit(0);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1000);
`,
      )
      return {
        entrypointCommand: [
          "node",
          resolve(repoDir, "node_modules", "tsx", "dist", "cli.mjs"),
          resolve(repoDir, "clawctl-daemon.ts"),
        ],
      }
    },
    resolveVersions: async () => ["main"],
    renderConfig: async () => [],
    chat: ({ homeDir, message }) => {
      clearBitclawOutbound(homeDir)
      writeBitclawInboundMessage(homeDir, message)
      return readBitclawResponse(homeDir)
    },
    runtimeEnv: ({ config, homeDir, installRoot }) => {
      const telegram = resolveTelegramSettings(config)
      return {
        HOME: homeDir,
        BITCLAW_HOME: homeDir,
        CLAWCTL_INSTALL_ROOT: installRoot,
        NO_COLOR: "1",
        CI: "1",
        ...(telegram.enabled ? { TELEGRAM_BOT_TOKEN: telegram.token } : {}),
        ...(telegram.chatId ? { TELEGRAM_CHAT_ID: telegram.chatId } : {}),
      }
    },
    start: ({ config, installRoot, homeDir, runtimeDir, stateDir, workspaceDir }) =>
      Promise.resolve({
        command: "node",
        args: [
          resolve(installRoot, "repo", "node_modules", "tsx", "dist", "cli.mjs"),
          resolve(installRoot, "repo", "clawctl-daemon.ts"),
        ],
        env: {
          HOME: homeDir,
          BITCLAW_HOME: homeDir,
          CLAWCTL_INSTALL_ROOT: installRoot,
          CLAWCTL_RUNTIME_DIR: runtimeDir,
          CLAWCTL_STATE_DIR: stateDir,
          CLAWCTL_WORKSPACE_DIR: workspaceDir,
          NO_COLOR: "1",
          CI: "1",
          ...(resolveTelegramSettings(config).enabled
            ? { TELEGRAM_BOT_TOKEN: resolveTelegramSettings(config).token }
            : {}),
          ...(resolveTelegramSettings(config).chatId
            ? { TELEGRAM_CHAT_ID: resolveTelegramSettings(config).chatId }
            : {}),
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

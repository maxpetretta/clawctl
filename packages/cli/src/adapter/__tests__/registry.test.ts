import { describe, expect, test } from "bun:test"

import {
  getBackendManifest,
  getRegisteredImplementation,
  installOnlyInteractionMessage,
  isInstallOnlyRegistration,
  listRegisteredImplementations,
} from "../registry.ts"
import type { InstallManifest, RuntimeManifest } from "../schema.ts"
import { validateAdapterRegistration, validateAdapterRegistry } from "../validate.ts"

const config = {
  CLAW_API_KEY: "secret",
  CLAW_BASE_URL: "https://example.test/v1",
  CLAW_MODEL: "test-model",
}

describe("adapter registry", () => {
  const runtimeInput = {
    config,
    homeDir: "/tmp/home",
    installRoot: "/tmp/install",
    runtimeDir: "/tmp/runtime",
    stateDir: "/tmp/runtime/state",
    workspaceDir: "/tmp/workspace",
  }

  test("lists the supported adapters and validates the registry", () => {
    expect(listRegisteredImplementations().map((entry) => entry.manifest.id)).toEqual([
      "nullclaw",
      "picoclaw",
      "zeroclaw",
      "openclaw",
      "nanobot",
      "hermes",
      "nanoclaw",
      "bitclaw",
      "ironclaw",
      "piclaw",
    ])
    expect(() => validateAdapterRegistry()).not.toThrow()
  })

  test("resolves backends and rejects unknown adapters", () => {
    expect(getBackendManifest("openclaw", "local")?.kind).toBe("local")
    expect(getBackendManifest("piclaw", "docker")?.kind).toBe("docker")
    expect(() => getRegisteredImplementation("ghostclaw")).toThrow("unsupported implementation: ghostclaw")
  })

  test("renders config and runtime env for local adapters", async () => {
    const nullclaw = getRegisteredImplementation("nullclaw")
    const picoclaw = getRegisteredImplementation("picoclaw")
    const zeroclaw = getRegisteredImplementation("zeroclaw")
    const openclaw = getRegisteredImplementation("openclaw")
    const nanobot = getRegisteredImplementation("nanobot")
    const hermes = getRegisteredImplementation("hermes")

    expect(
      nullclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/nullclaw", message: "hi", ...runtimeInput }),
    ).toEqual(["/bin/nullclaw", "agent", "-m", "hi"])
    expect(
      picoclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/picoclaw", message: "hi", ...runtimeInput }),
    ).toContain("--session")
    expect(
      zeroclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/zeroclaw", message: "hi", ...runtimeInput }),
    ).toEqual(["/bin/zeroclaw", "agent", "-m", "hi"])
    expect(
      openclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/openclaw", message: "hi", ...runtimeInput }),
    ).toContain("--json")
    expect(
      nanobot.implementationHooks.buildChatCommand({ binaryPath: "/bin/nanobot", message: "hi", ...runtimeInput }),
    ).toEqual([
      "/bin/nanobot",
      "agent",
      "--config",
      "/tmp/home/.nanobot/config.json",
      "--workspace",
      "/tmp/workspace",
      "--message",
      "hi",
    ])
    expect(
      hermes.implementationHooks.buildChatCommand({
        binaryPath: "/tmp/install/repo/venv/bin/python",
        message: "hi",
        ...runtimeInput,
      }),
    ).toEqual(["/tmp/install/repo/venv/bin/python", "/tmp/install/clawctl-hermes-chat.py", "hi"])

    const nullFiles = await nullclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const picoFiles = await picoclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const zeroFiles = await zeroclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const openFiles = await openclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const nanoFiles = await nanobot.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const hermesFiles = await hermes.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })

    expect(nullFiles[0]?.content).toContain("/tmp/workspace")
    expect(picoFiles[0]?.content).toContain("test-model")
    expect(zeroFiles[0]?.content).toContain("default_model")
    expect(openFiles[0]?.content).toContain("openai-completions")
    expect(nanoFiles[0]?.content).toContain('"provider": "custom"')
    expect(hermesFiles[0]?.path).toBe(".env")
    expect(hermesFiles[0]?.content).toContain("OPENAI_BASE_URL=https://example.test/v1")
    expect(hermesFiles[0]?.content).toContain("OPENAI_API_KEY=secret")
    expect(hermesFiles[0]?.content).toContain("LLM_MODEL=test-model")
    expect(hermesFiles[0]?.content).toContain("TERMINAL_CWD=/tmp/workspace")

    expect(
      nullclaw.implementationHooks.runtimeEnv({
        ...runtimeInput,
      }),
    ).toEqual({
      HOME: "/tmp/home",
      CLAWCTL_INSTALL_ROOT: "/tmp/install",
    })
    expect(
      picoclaw.implementationHooks.runtimeEnv({
        ...runtimeInput,
      }),
    ).toEqual({
      HOME: "/tmp/home",
      PICOCLAW_HOME: "/tmp/home",
      CLAWCTL_INSTALL_ROOT: "/tmp/install",
    })
    expect(
      zeroclaw.implementationHooks.runtimeEnv({
        ...runtimeInput,
      }),
    ).toEqual({
      HOME: "/tmp/home",
      CLAWCTL_INSTALL_ROOT: "/tmp/install",
    })
    expect(
      openclaw.implementationHooks.runtimeEnv({
        ...runtimeInput,
      }),
    ).toEqual({
      HOME: "/tmp/home",
      OPENCLAW_CONFIG_PATH: "/tmp/home/.openclaw/openclaw.json",
      OPENCLAW_STATE_DIR: "/tmp/runtime/state",
      NODE_ENV: "production",
      NO_COLOR: "1",
      CI: "1",
      TERM: "dumb",
    })
    expect(
      nanobot.implementationHooks.runtimeEnv({
        ...runtimeInput,
      }),
    ).toEqual({
      HOME: "/tmp/home",
      CLAWCTL_INSTALL_ROOT: "/tmp/install",
      NO_COLOR: "1",
    })
    expect(
      hermes.implementationHooks.runtimeEnv({
        ...runtimeInput,
      }),
    ).toEqual({
      HOME: "/tmp/home",
      HERMES_HOME: "/tmp/home",
      CLAWCTL_INSTALL_ROOT: "/tmp/install",
      TERMINAL_CWD: "/tmp/workspace",
      MSWEA_GLOBAL_CONFIG_DIR: "/tmp/home",
      MSWEA_SILENT_STARTUP: "1",
      HERMES_QUIET: "1",
      NO_COLOR: "1",
      CI: "1",
      PATH: `/tmp/install/repo/venv/bin:/tmp/install/repo/node_modules/.bin:${process.env.PATH ?? ""}`,
    })
  })

  test("supports openclaw output normalization and experimental adapters", () => {
    const openclaw = getRegisteredImplementation("openclaw")
    const hermes = getRegisteredImplementation("hermes")
    const nanoclaw = getRegisteredImplementation("nanoclaw")
    const bitclaw = getRegisteredImplementation("bitclaw")
    const ironclaw = getRegisteredImplementation("ironclaw")
    const piclaw = getRegisteredImplementation("piclaw")

    expect(
      openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"response":{"text":"alpha"}}', stderr: "" }),
    ).toBe("alpha")
    expect(openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"reply":"beta"}', stderr: "" })).toBe("beta")
    expect(
      openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"message":{"text":"gamma"}}', stderr: "" }),
    ).toBe("gamma")
    expect(
      openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"output":{"text":"epsilon"}}', stderr: "" }),
    ).toBe("epsilon")
    expect(
      openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"payloads":[{"text":"delta"}]}', stderr: "" }),
    ).toBe("delta")
    expect(() =>
      openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"payloads":[{}]}', stderr: "bad-array" }),
    ).toThrow("openclaw did not return chat text: bad-array")
    expect(() =>
      openclaw.implementationHooks.normalizeChatOutput?.({ stdout: '{"noop":true}', stderr: "bad" }),
    ).toThrow("openclaw did not return chat text: bad")

    expect(hermes.implementationHooks.resolveVersions).toBeDefined()
    expect(hermes.implementationHooks.install).toBeDefined()
    expect(hermes.implementationHooks.start).toBeDefined()
    expect(hermes.implementationHooks.status).toBeDefined()
    expect(isInstallOnlyRegistration(hermes)).toBe(false)
    expect(nanoclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi", ...runtimeInput })).toEqual(
      [],
    )
    expect(bitclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi", ...runtimeInput })).toEqual([])
    expect(nanoclaw.implementationHooks.buildShimCommand).toBeUndefined()
    expect(bitclaw.implementationHooks.buildShimCommand).toBeUndefined()
    expect(ironclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi", ...runtimeInput })).toEqual(
      [],
    )
    expect(piclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi", ...runtimeInput })).toEqual([])
    expect(nanoclaw.manifest.backends[0]?.install[0]?.versionSource).toEqual({
      kind: "adapter-hook",
      hook: "resolveVersions",
    })
    expect(piclaw.manifest.backends[1]?.install[0]?.versionSource).toEqual({
      kind: "git-tags",
      repository: "https://github.com/rcarmo/piclaw.git",
    })
    expect(nanoclaw.implementationHooks.resolveVersions).toBeDefined()
    expect(nanoclaw.implementationHooks.install).toBeDefined()
    expect(nanoclaw.implementationHooks.start).toBeUndefined()
    expect(nanoclaw.implementationHooks.status).toBeUndefined()
    expect(isInstallOnlyRegistration(nanoclaw)).toBe(true)
    expect(bitclaw.implementationHooks.install).toBeDefined()
    expect(bitclaw.implementationHooks.start).toBeUndefined()
    expect(bitclaw.implementationHooks.status).toBeUndefined()
    expect(bitclaw.implementationHooks.chat).toBeUndefined()
    expect(bitclaw.manifest.capabilities.chat).toBe(false)
    expect(bitclaw.manifest.capabilities.ping).toBe(false)
    expect(isInstallOnlyRegistration(bitclaw)).toBe(true)
    expect(isInstallOnlyRegistration(ironclaw)).toBe(true)
    expect(isInstallOnlyRegistration(piclaw)).toBe(true)
    expect(installOnlyInteractionMessage("bitclaw")).toBe(
      "bitclaw is install-only in clawctl; it is not interactable or executable",
    )
    expect(ironclaw.manifest.backends[0]?.install[0]).toMatchObject({
      strategy: "github-release",
      repository: "nearai/ironclaw",
      versionSource: { kind: "github-releases", repository: "nearai/ironclaw" },
    })
  })

  test("validates invalid adapter registrations", () => {
    const localRuntime: RuntimeManifest = {
      supervision: { kind: "native-daemon" },
      homeStrategy: "isolated-home",
      workspaceStrategy: "per-runtime",
      entrypoint: { kind: "adapter-hook", hook: "start" },
      health: { kind: "adapter-hook", hook: "status" },
      chat: { kind: "adapter-hook", hook: "chat" },
      ping: { kind: "prompt", text: "pong" },
    }
    const install: InstallManifest[] = [
      {
        strategy: "github-release",
        priority: 1,
        repository: "example/example",
        versionSource: { kind: "github-releases", repository: "example/example" },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        assetRules: [
          {
            match: { os: "darwin", arch: "arm64" },
            pattern: "tool.tar.gz",
            archive: { kind: "none" },
          },
        ],
        verification: { kind: "none" },
      },
    ]
    const base = getRegisteredImplementation("openclaw")

    expect(() =>
      validateAdapterRegistration({
        manifest: {
          ...base.manifest,
          id: "ghostclaw",
          backends: [],
        },
      }),
    ).toThrow("adapter ghostclaw has no backends")

    expect(() =>
      validateAdapterRegistration({
        manifest: {
          ...base.manifest,
          id: "ghostclaw",
          backends: [{ kind: "weird", supported: true, install, runtime: localRuntime }] as never,
        },
      }),
    ).toThrow("adapter ghostclaw has unsupported backend kind")

    expect(() =>
      validateAdapterRegistration({
        manifest: {
          ...base.manifest,
          id: "ghostclaw",
          backends: [{ kind: "local", supported: true, install: [], runtime: localRuntime }],
        },
      }),
    ).toThrow("adapter ghostclaw backend local has no install strategies")

    expect(() =>
      validateAdapterRegistration({
        manifest: {
          ...base.manifest,
          id: "ghostclaw",
          backends: [
            {
              kind: "local",
              supported: true,
              install,
              runtime: {
                ...localRuntime,
                supervision: { kind: "unmanaged" },
              },
            },
          ],
        },
      }),
    ).toThrow("adapter ghostclaw cannot declare chat or ping with unmanaged supervision")

    expect(() =>
      validateAdapterRegistration({
        manifest: {
          ...base.manifest,
          id: "ghostclaw",
        },
      }),
    ).toThrow("adapter ghostclaw native-daemon supervision requires a start hook")

    const seenIds = new Set(["openclaw"])
    expect(() => validateAdapterRegistration(base, seenIds)).toThrow("duplicate adapter id: openclaw")
  })
})

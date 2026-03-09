import { describe, expect, test } from "bun:test"

import { getBackendManifest, getRegisteredImplementation, listRegisteredImplementations } from "./registry.ts"
import type { InstallManifest, RuntimeManifest } from "./schema.ts"
import { validateAdapterRegistration, validateAdapterRegistry } from "./validate.ts"

const config = {
  CLAW_API_KEY: "secret",
  CLAW_BASE_URL: "https://example.test/v1",
  CLAW_MODEL: "test-model",
}

describe("adapter registry", () => {
  test("lists the supported adapters and validates the registry", () => {
    expect(listRegisteredImplementations().map((entry) => entry.manifest.id)).toEqual([
      "nullclaw",
      "picoclaw",
      "zeroclaw",
      "openclaw",
      "nanobot",
      "nanoclaw",
      "bitclaw",
      "piclaw",
    ])
    expect(() => validateAdapterRegistry()).not.toThrow()
  })

  test("resolves backends and rejects unknown adapters", () => {
    expect(getBackendManifest("openclaw", "local")?.kind).toBe("local")
    expect(getBackendManifest("piclaw", "docker")?.kind).toBe("docker")
    expect(() => getRegisteredImplementation("ghostclaw")).toThrow("unsupported implementation: ghostclaw")
  })

  test("renders config and runtime env for local one-shot claws", async () => {
    const nullclaw = getRegisteredImplementation("nullclaw")
    const picoclaw = getRegisteredImplementation("picoclaw")
    const zeroclaw = getRegisteredImplementation("zeroclaw")
    const openclaw = getRegisteredImplementation("openclaw")
    const nanobot = getRegisteredImplementation("nanobot")

    expect(nullclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/nullclaw", message: "hi" })).toEqual([
      "/bin/nullclaw",
      "agent",
      "-m",
      "hi",
    ])
    expect(picoclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/picoclaw", message: "hi" })).toContain(
      "--session",
    )
    expect(zeroclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/zeroclaw", message: "hi" })).toEqual([
      "/bin/zeroclaw",
      "agent",
      "-m",
      "hi",
    ])
    expect(openclaw.implementationHooks.buildChatCommand({ binaryPath: "/bin/openclaw", message: "hi" })).toContain(
      "--json",
    )
    expect(nanobot.implementationHooks.buildChatCommand({ binaryPath: "/bin/nanobot", message: "hi" })).toContain(
      "--no-logs",
    )

    const nullFiles = await nullclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const picoFiles = await picoclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const zeroFiles = await zeroclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const openFiles = await openclaw.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })
    const nanoFiles = await nanobot.implementationHooks.renderConfig({ config, workspaceDir: "/tmp/workspace" })

    expect(nullFiles[0]?.content).toContain("/tmp/workspace")
    expect(picoFiles[0]?.content).toContain("test-model")
    expect(zeroFiles[0]?.content).toContain("default_model")
    expect(openFiles[0]?.content).toContain("openai-completions")
    expect(nanoFiles[0]?.content).toContain('"provider": "custom"')

    expect(
      nullclaw.implementationHooks.runtimeEnv({
        homeDir: "/tmp/home",
        runtimeDir: "/tmp/runtime",
        workspaceDir: "/tmp/workspace",
      }),
    ).toEqual({
      HOME: "/tmp/home",
      NULLCLAW_HOME: "/tmp/home/.nullclaw",
      NULLCLAW_WORKSPACE: "/tmp/workspace",
    })
    expect(
      picoclaw.implementationHooks.runtimeEnv({
        homeDir: "/tmp/home",
        runtimeDir: "/tmp/runtime",
        workspaceDir: "/tmp/workspace",
      }),
    ).toEqual({
      HOME: "/tmp/home",
      PICOCLAW_HOME: "/tmp/home",
    })
    expect(
      zeroclaw.implementationHooks.runtimeEnv({
        homeDir: "/tmp/home",
        runtimeDir: "/tmp/runtime",
        workspaceDir: "/tmp/workspace",
      }),
    ).toEqual({
      HOME: "/tmp/home",
    })
    expect(
      openclaw.implementationHooks.runtimeEnv({
        homeDir: "/tmp/home",
        runtimeDir: "/tmp/runtime",
        workspaceDir: "/tmp/workspace",
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
        homeDir: "/tmp/home",
        runtimeDir: "/tmp/runtime",
        workspaceDir: "/tmp/workspace",
      }),
    ).toEqual({
      HOME: "/tmp/home",
      PYTHONUNBUFFERED: "1",
    })
  })

  test("supports openclaw output normalization and install-only adapters", () => {
    const openclaw = getRegisteredImplementation("openclaw")
    const nanoclaw = getRegisteredImplementation("nanoclaw")
    const bitclaw = getRegisteredImplementation("bitclaw")
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

    expect(nanoclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi" })).toEqual([])
    expect(bitclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi" })).toEqual([])
    expect(piclaw.implementationHooks.buildChatCommand({ binaryPath: "", message: "hi" })).toEqual([])
  })

  test("validates invalid adapter registrations", () => {
    const localRuntime: RuntimeManifest = {
      mode: "oneshot",
      homeStrategy: "isolated-home",
      workspaceStrategy: "per-runtime",
      entrypoint: { kind: "exec", command: ["tool"] },
      health: { kind: "none" },
      chat: { kind: "argv", command: ["tool"] },
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
                mode: "external",
              },
            },
          ],
        },
      }),
    ).toThrow("adapter ghostclaw cannot declare chat or ping with external runtime mode")

    const seenIds = new Set(["openclaw"])
    expect(() => validateAdapterRegistration(base, seenIds)).toThrow("duplicate adapter id: openclaw")
  })
})

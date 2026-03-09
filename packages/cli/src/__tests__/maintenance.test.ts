import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"

import type { InstallRecord } from "../adapter/types.ts"
import { userError } from "../errors.ts"
import { ClawctlMaintenanceService, isPlatformSupported, requiredCommandsForInstall } from "../maintenance-service.ts"
import { ClawctlPathsService } from "../paths-service.ts"
import { missingSharedConfigKeys } from "../shared-config.ts"
import { ClawctlStoreService } from "../store-service.ts"
import { makeMaintenanceLayer, runWithLayer } from "../test-layer.ts"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-maintenance-"))
  tempRoots.push(root)
  return root
}

async function writeExecutable(destination: string) {
  await writeFile(destination, "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(destination, 0o755)
}

function record(
  root: string,
  input: Partial<InstallRecord> & Pick<InstallRecord, "implementation" | "resolvedVersion">,
) {
  return {
    implementation: input.implementation,
    requestedVersion: input.requestedVersion ?? input.resolvedVersion,
    resolvedVersion: input.resolvedVersion,
    backend: input.backend ?? "local",
    installStrategy: input.installStrategy ?? "npm-package",
    installRoot: input.installRoot ?? join(root, "installs", "local", input.implementation, input.resolvedVersion),
    entrypointCommand: input.entrypointCommand ?? [],
    platform: input.platform ?? { os: "darwin", arch: "arm64" },
    sourceReference: input.sourceReference ?? "fixture",
    verificationSummary: input.verificationSummary,
    installedAt: input.installedAt ?? "2026-03-09T00:00:00.000Z",
    supportTier: input.supportTier ?? "tier2",
  } satisfies InstallRecord
}

afterEach(async () => {
  process.env.CLAWCTL_GIT_BIN = undefined
  process.env.CLAWCTL_NPM_BIN = undefined
  process.env.CLAWCTL_DOCKER_BIN = undefined
  process.env.CLAWCTL_BUN_BIN = undefined
  process.env.PATH = originalPath
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const originalPath = process.env.PATH ?? ""

describe("maintenance service", () => {
  test("exposes pure install and config helper behavior", () => {
    expect(isPlatformSupported([{ os: "darwin", arch: "arm64" }], { os: "darwin", arch: "arm64" })).toBe(true)
    expect(isPlatformSupported([{ os: "linux", arch: "arm64" }], { os: "darwin", arch: "arm64" })).toBe(false)

    expect(
      requiredCommandsForInstall({
        strategy: "github-release",
        priority: 1,
        repository: "example/example",
        versionSource: { kind: "github-releases", repository: "example/example" },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        assetRules: [
          {
            match: { os: "darwin", arch: "arm64" },
            pattern: "tool.tar.gz",
            archive: { kind: "tar.gz", binaryPath: "tool" },
          },
          {
            match: { os: "darwin", arch: "arm64" },
            pattern: "tool.zip",
            archive: { kind: "zip", binaryPath: "tool" },
          },
        ],
        verification: { kind: "none" },
      }),
    ).toEqual(["tar", "unzip"])
    expect(
      requiredCommandsForInstall({
        strategy: "python-package",
        priority: 1,
        packageName: "nanobot-ai",
        versionSource: { kind: "pypi", packageName: "nanobot-ai" },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        installer: "pip-venv",
        entrypoint: "nanobot",
      }),
    ).toEqual(["python3", "pip3"])
    expect(
      requiredCommandsForInstall({
        strategy: "docker-build",
        priority: 1,
        context: ".",
        dockerfile: "Dockerfile",
        image: "clawctl:test",
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        versionSource: { kind: "static", versions: ["latest"] },
      }),
    ).toEqual([process.env.CLAWCTL_DOCKER_BIN ?? "docker"])
    expect(
      requiredCommandsForInstall({
        strategy: "source-build",
        priority: 1,
        repository: "example/example",
        versionSource: { kind: "static", versions: ["v1.0.0"] },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        buildHook: "install",
      }),
    ).toEqual([process.env.CLAWCTL_GIT_BIN ?? "git", process.env.CLAWCTL_BUN_BIN ?? "bun"])

    expect(
      missingSharedConfigKeys(
        {
          CLAW_API_KEY: Redacted.make("replace-me"),
          CLAW_BASE_URL: "https://openrouter.ai/api/v1",
          CLAW_MODEL: "ok",
          TELEGRAM_BOT_TOKEN: Redacted.make(""),
          TELEGRAM_BOT_USERNAME: "",
          TELEGRAM_CHAT_ID: "",
          TELEGRAM_ALLOWED_FROM: "",
        },
        ["CLAW_API_KEY", "CLAW_MODEL", "TELEGRAM_BOT_TOKEN"],
      ),
    ).toEqual(["CLAW_API_KEY", "TELEGRAM_BOT_TOKEN"])
  })

  test("doctor reports healthy installed adapters", async () => {
    const root = await createRoot()
    const toolsDir = join(root, "tools")
    const npmPath = join(toolsDir, "npm")
    const openclawPath = join(toolsDir, "openclaw")
    await mkdir(toolsDir, { recursive: true })
    await writeExecutable(npmPath)
    await writeExecutable(openclawPath)
    process.env.CLAWCTL_NPM_BIN = npmPath
    process.env.PATH = `${join(root, "bin")}:${originalPath}`

    const report = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        const maintenance = yield* ClawctlMaintenanceService
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        yield* store.writeInstallRecord(
          record(root, {
            implementation: "openclaw",
            resolvedVersion: "2026.3.7",
            entrypointCommand: [openclawPath],
          }),
        )
        return yield* maintenance.runDoctor("openclaw")
      }),
      makeMaintenanceLayer(root),
    )

    expect(report.ok).toBe(true)
    expect(report.checks.some((check) => check.label === "openclaw:entrypoint:2026.3.7" && check.ok)).toBe(true)
  })

  test("doctor uses current selection and handles entrypoint-free installs", async () => {
    const root = await createRoot()
    process.env.CLAWCTL_GIT_BIN = "/usr/bin/git"
    process.env.PATH = `${join(root, "bin")}:${originalPath}`

    const report = await runWithLayer(
      Effect.gen(function* () {
        const paths = yield* ClawctlPathsService
        const store = yield* ClawctlStoreService
        const maintenance = yield* ClawctlMaintenanceService
        yield* store.writeInstallRecord(
          record(root, {
            implementation: "nanoclaw",
            resolvedVersion: "main",
            installStrategy: "repo-bootstrap",
            entrypointCommand: [],
            supportTier: "tier3",
          }),
        )
        yield* store.writeCurrentSelection({
          implementation: "nanoclaw",
          version: "main",
          backend: "local",
        })
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(paths.paths.binDir, { recursive: true })
            await writeExecutable(paths.activeShim())
            await writeExecutable(paths.implementationShim("nanoclaw"))
          },
          catch: (cause) => userError("maintenance.test", String(cause)),
        })
        return yield* maintenance.runDoctor()
      }),
      makeMaintenanceLayer(root),
    )

    expect(report.ok).toBe(true)
    expect(report.checks.some((check) => check.label === "path:bin" && check.ok)).toBe(true)
    expect(report.checks.some((check) => check.label === "shim:claw" && check.ok)).toBe(true)
    expect(
      report.checks.some(
        (check) => check.label === "nanoclaw:entrypoint:main" && check.detail === "no direct local entrypoint declared",
      ),
    ).toBe(true)
  })

  test("doctor reports missing shared config and tools", async () => {
    const root = await createRoot()
    process.env.CLAWCTL_DOCKER_BIN = join(root, "missing-docker")

    const report = await runWithLayer(
      Effect.gen(function* () {
        const maintenance = yield* ClawctlMaintenanceService
        return yield* maintenance.runDoctor("piclaw")
      }),
      makeMaintenanceLayer(root),
    )

    expect(report.ok).toBe(false)
    expect(report.checks.some((check) => check.label.includes("piclaw:docker:tool") && !check.ok)).toBe(true)
  })

  test("cleanup clears stale current selections and stale directories", async () => {
    const root = await createRoot()

    const report = await runWithLayer(
      Effect.gen(function* () {
        const maintenance = yield* ClawctlMaintenanceService
        const paths = yield* ClawctlPathsService
        const store = yield* ClawctlStoreService
        yield* store.writeCurrentSelection({
          implementation: "openclaw",
          version: "2026.3.7",
          backend: "local",
        })
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(join(paths.paths.installDir, "local", "openclaw", "2026.3.7.partial-stale"), {
              recursive: true,
            })
            await mkdir(join(paths.paths.runtimeDir, "local", "openclaw", "2026.3.6"), { recursive: true })
          },
          catch: (cause) => userError("maintenance.test", String(cause)),
        })
        return yield* maintenance.runCleanup("openclaw")
      }),
      makeMaintenanceLayer(root),
    )

    expect(report.clearedCurrent).toBe(true)
    expect(report.removedPartialInstalls).toBe(1)
    expect(report.removedRuntimeDirs).toBe(1)
  })

  test("doctor returns registry-only status when nothing is installed", async () => {
    const root = await createRoot()

    const report = await runWithLayer(
      Effect.gen(function* () {
        const maintenance = yield* ClawctlMaintenanceService
        return yield* maintenance.runDoctor()
      }),
      makeMaintenanceLayer(root),
    )

    expect(report.ok).toBe(false)
    expect(report.checks).toEqual([
      { label: "registry", ok: true, detail: "adapter registry is valid" },
      {
        label: "path:bin",
        ok: false,
        detail: `add ${join(root, "bin")} to PATH to use active claw shims`,
      },
    ])
  })
})

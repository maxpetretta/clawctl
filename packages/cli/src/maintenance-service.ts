import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import { Context, Effect, Layer } from "effect"
import type { InstallManifest, PlatformSelector } from "./adapter/schema.ts"
import { ensureClawctlDirectories } from "./directory-helpers.ts"
import { type ClawctlError, withSystemError } from "./errors.ts"
import { ClawctlPathsService } from "./paths-service.ts"
import { currentHostPlatform } from "./platform.ts"
import { makeResolveRegistration } from "./service-helpers.ts"
import { missingSharedConfigKeys } from "./shared-config.ts"
import { ClawctlStoreService } from "./store-service.ts"
import { bunExecutable, dockerExecutable, gitExecutable, npmExecutable, uvExecutable } from "./tooling.ts"

export type DoctorCheck = {
  readonly detail: string
  readonly label: string
  readonly ok: boolean
}

export type CleanupReport = {
  readonly clearedCurrent: boolean
  readonly removedPartialInstalls: number
  readonly removedRuntimeDirs: number
}

type DoctorReport = {
  readonly checks: DoctorCheck[]
  readonly ok: boolean
}

type ClawctlMaintenanceApi = {
  readonly runDoctor: (target?: string) => Effect.Effect<DoctorReport, ClawctlError>
  readonly runCleanup: (target?: string) => Effect.Effect<CleanupReport, ClawctlError>
}

export class ClawctlMaintenanceService extends Context.Tag("@clawctl/cli/ClawctlMaintenanceService")<
  ClawctlMaintenanceService,
  ClawctlMaintenanceApi
>() {}

export function isPlatformSupported(supportedPlatforms: PlatformSelector[], host: PlatformSelector): boolean {
  return supportedPlatforms.some(
    (candidate) =>
      candidate.os === host.os &&
      candidate.arch === host.arch &&
      (candidate.libc === undefined || candidate.libc === host.libc),
  )
}

export function requiredCommandsForInstall(strategy: InstallManifest): string[] {
  switch (strategy.strategy) {
    case "github-release": {
      const required = new Set<string>()
      for (const rule of strategy.assetRules) {
        if (rule.archive.kind === "tar.gz") {
          required.add("tar")
        }
        if (rule.archive.kind === "zip") {
          required.add("unzip")
        }
      }
      return [...required]
    }
    case "npm-package":
      return [npmExecutable()]
    case "python-package":
      return strategy.installer.startsWith("uv-") ? [uvExecutable()] : ["python3", "pip3"]
    case "repo-bootstrap":
      return [gitExecutable()]
    case "docker-build":
      return [dockerExecutable()]
    case "source-build":
      return [gitExecutable(), bunExecutable()]
  }
}

export const ClawctlMaintenanceLive = Layer.effect(
  ClawctlMaintenanceService,
  Effect.gen(function* () {
    const commandExecutor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const { path, paths } = yield* ClawctlPathsService
    const store = yield* ClawctlStoreService
    const resolveRegistration = makeResolveRegistration("ClawctlMaintenanceService")

    const commandExists = Effect.fn("ClawctlMaintenanceService.commandExists")(function* (command: string) {
      if (command.includes("/")) {
        return yield* withSystemError(
          "maintenance.commandExistsPath",
          fs.access(command).pipe(
            Effect.as(true),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
        )
      }

      const shellQuotedCommand = `'${command.replaceAll("'", `'\\''`)}'`
      return yield* withSystemError(
        "maintenance.commandExists",
        commandExecutor
          .exitCode(
            Command.make("sh", "-lc", `command -v ${shellQuotedCommand} >/dev/null 2>&1`).pipe(
              Command.env(process.env),
            ),
          )
          .pipe(
            Effect.map((exitCode) => Number(exitCode) === 0),
            Effect.catchAll(() => Effect.succeed(false)),
          ),
      )
    })

    const listSubdirectories = Effect.fn("ClawctlMaintenanceService.listSubdirectories")(function* (directory: string) {
      const exists = yield* withSystemError("maintenance.directoryExists", fs.exists(directory))
      if (!exists) {
        return [] as string[]
      }
      return (yield* withSystemError("maintenance.readDirectory", fs.readDirectory(directory))).sort((left, right) =>
        left.localeCompare(right),
      )
    })

    const selectDoctorTargets = Effect.fn("ClawctlMaintenanceService.selectDoctorTargets")(function* (target?: string) {
      if (target) {
        return [target]
      }

      const current = yield* store.readCurrentSelection
      if (current) {
        return [current.implementation]
      }

      const installed = yield* store.listInstallRecords
      if (installed.length > 0) {
        return [...new Set(installed.map((record) => record.implementation))]
      }

      return []
    })

    const runDoctor = Effect.fn("ClawctlMaintenanceService.runDoctor")(function* (target?: string) {
      const config = yield* store.readSharedConfig
      const host = currentHostPlatform()
      const pathEntries = (process.env.PATH ?? "").split(":").filter((entry) => entry.length > 0)
      const checks: DoctorCheck[] = [
        { label: "registry", ok: true, detail: "adapter registry is valid" },
        {
          label: "path:bin",
          ok: pathEntries.includes(paths.binDir),
          detail: pathEntries.includes(paths.binDir)
            ? `${paths.binDir} is on PATH`
            : `add ${paths.binDir} to PATH to use active claw shims`,
        },
      ]
      const targets = yield* selectDoctorTargets(target)
      const installedRecords = yield* store.listInstallRecords
      const currentSelection = yield* store.readCurrentSelection

      if (currentSelection) {
        const activeShim = path.resolve(paths.binDir, "claw")
        checks.push({
          label: "shim:claw",
          ok: yield* commandExists(activeShim),
          detail: activeShim,
        })
      }

      for (const implementationId of targets) {
        const registration = yield* resolveRegistration(implementationId)
        checks.push({
          label: `${implementationId}:manifest`,
          ok: true,
          detail: `${registration.manifest.supportTier} adapter`,
        })

        for (const backend of registration.manifest.backends) {
          if (!backend.supported) {
            checks.push({
              label: `${implementationId}:${backend.kind}`,
              ok: true,
              detail: "backend declared but not supported yet",
            })
            continue
          }

          const strategy = backend.install[0] as InstallManifest
          checks.push({
            label: `${implementationId}:${backend.kind}:platform`,
            ok: isPlatformSupported(strategy.supportedPlatforms, host),
            detail: `${host.os}-${host.arch}`,
          })

          for (const command of requiredCommandsForInstall(strategy)) {
            checks.push({
              label: `${implementationId}:${backend.kind}:tool:${command}`,
              ok: yield* commandExists(command),
              detail: "required for install/runtime",
            })
          }
        }

        const sharedKeys = registration.manifest.config.sharedKeys
        if (sharedKeys.length > 0) {
          const missingKeys = missingSharedConfigKeys(config, sharedKeys)
          checks.push({
            label: `${implementationId}:shared-config`,
            ok: missingKeys.length === 0,
            detail: missingKeys.length === 0 ? "required shared keys present" : `missing ${missingKeys.join(", ")}`,
          })
        }

        if (currentSelection?.implementation === implementationId) {
          const implementationShim = path.resolve(paths.binDir, implementationId)
          checks.push({
            label: `${implementationId}:shim`,
            ok: yield* commandExists(implementationShim),
            detail: implementationShim,
          })
        }

        const records = installedRecords.filter((record) => record.implementation === implementationId)
        if (records.length === 0) {
          checks.push({
            label: `${implementationId}:install`,
            ok: true,
            detail: "not installed",
          })
          continue
        }

        for (const record of records) {
          const entrypoint = record.entrypointCommand[0]
          checks.push({
            label: `${implementationId}:install:${record.resolvedVersion}`,
            ok: true,
            detail: `installed via ${record.installStrategy}`,
          })
          if (record.backend === "docker") {
            checks.push({
              label: `${implementationId}:entrypoint:${record.resolvedVersion}`,
              ok: entrypoint !== undefined && entrypoint.length > 0,
              detail: entrypoint
                ? `container command: ${record.entrypointCommand.join(" ")}`
                : "no container entrypoint declared",
            })
            continue
          }
          if (!entrypoint) {
            checks.push({
              label: `${implementationId}:entrypoint:${record.resolvedVersion}`,
              ok: true,
              detail: "no direct local entrypoint declared",
            })
            continue
          }
          checks.push({
            label: `${implementationId}:entrypoint:${record.resolvedVersion}`,
            ok: yield* commandExists(entrypoint),
            detail: entrypoint,
          })
        }
      }

      return {
        checks,
        ok: checks.every((check) => check.ok),
      }
    })

    const runCleanup = Effect.fn("ClawctlMaintenanceService.runCleanup")(function* (target?: string) {
      yield* ensureClawctlDirectories(fs, paths, "maintenance.ensure", ["root", "install", "runtime"])

      let removedPartialInstalls = 0
      let removedRuntimeDirs = 0
      const installBackends = yield* listSubdirectories(paths.installDir)
      const runtimeBackends = yield* listSubdirectories(paths.runtimeDir)
      const backends =
        target === undefined
          ? [...new Set([...installBackends, ...runtimeBackends])]
          : [...new Set([...installBackends, ...runtimeBackends, "local", "docker"])]

      for (const backend of backends) {
        const installImplementations = yield* listSubdirectories(path.resolve(paths.installDir, backend))
        const runtimeImplementations = yield* listSubdirectories(path.resolve(paths.runtimeDir, backend))
        const targets =
          target === undefined ? [...new Set([...installImplementations, ...runtimeImplementations])] : [target]
        for (const implementationId of targets) {
          removedPartialInstalls += yield* store.cleanupPartialInstallDirectories(implementationId, backend)
          removedRuntimeDirs += yield* store.cleanupOrphanedRuntimeDirectories(implementationId, backend)
        }
      }

      let clearedCurrent = false
      const current = yield* store.readCurrentSelection
      if (current) {
        const stillInstalled = yield* store
          .resolveInstalledRecord(current.implementation, current.version, current.backend)
          .pipe(
            Effect.as(true),
            Effect.catchAll(() => Effect.succeed(false)),
          )
        if (!stillInstalled) {
          yield* store.clearCurrentSelection
          clearedCurrent = true
        }
      }

      return {
        clearedCurrent,
        removedPartialInstalls,
        removedRuntimeDirs,
      }
    })

    return ClawctlMaintenanceService.of({
      runDoctor,
      runCleanup,
    })
  }),
)

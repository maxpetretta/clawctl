import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import { BunContext } from "@effect/platform-bun"
import { Context, Effect, Layer, type Option } from "effect"
import { installOnlyInteractionMessage, isInstallOnlyRegistration } from "./adapter/registry.ts"
import type { RuntimeManifest } from "./adapter/schema.ts"
import type { InstallRecord, RegisteredImplementation, RuntimeRecord } from "./adapter/types.ts"
import { type ClawctlError, userError, withSystemError } from "./errors.ts"
import { repairInstallRootReference, repairPythonScriptShebang } from "./installer-service.ts"
import { isRuntimeBackend, type RuntimeBackend } from "./model.ts"
import { ClawctlPathsLive, ClawctlPathsService } from "./paths-service.ts"
import {
  makeParseReference,
  makeRequireInteractableImplementation,
  makeResolveRegistration,
} from "./service-helpers.ts"
import { missingSharedConfigKeys, sharedConfigToEntries, sharedConfigValue } from "./shared-config.ts"
import { ClawctlStoreLive, ClawctlStoreService } from "./store-service.ts"
import type { TargetReference } from "./target.ts"
import { dockerExecutable } from "./tooling.ts"

const daemonSentinel = "__daemon__"
const shimSentinel = "__shim__"
const daemonStartupPolls = 50
const daemonStartupSleep = "100 millis"

export type RuntimeSnapshot = {
  readonly active: boolean
  readonly managedByClawctl: boolean
  readonly pid?: number
  readonly port?: number
  readonly state: RuntimeRecord["state"]
}

type StopSelectionResult = {
  readonly record?: InstallRecord
  readonly stopped: boolean
}

type ClawctlRuntimeApi = {
  readonly activateSelection: (target: TargetReference) => Effect.Effect<InstallRecord, ClawctlError>
  readonly ensureActiveChatTarget: (
    target: Option.Option<string>,
    capability?: "chat" | "ping",
  ) => Effect.Effect<InstallRecord, ClawctlError>
  readonly prepareRuntime: (record: InstallRecord) => Effect.Effect<void, ClawctlError>
  readonly requestChat: (record: InstallRecord, message: string) => Effect.Effect<string, ClawctlError>
  readonly runChatDirect: (record: InstallRecord, message: string) => Effect.Effect<string, ClawctlError>
  readonly runShimmedCommand: (
    implementation: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<number, ClawctlError>
  readonly pingText: () => string
  readonly runtimeState: (record: InstallRecord) => Effect.Effect<RuntimeSnapshot, ClawctlError>
  readonly stopSelection: (
    target: Option.Option<string>,
    backend?: RuntimeBackend,
  ) => Effect.Effect<StopSelectionResult, ClawctlError>
}

export class ClawctlRuntimeService extends Context.Tag("@clawctl/cli/ClawctlRuntimeService")<
  ClawctlRuntimeService,
  ClawctlRuntimeApi
>() {}

type DaemonServices = {
  paths: {
    runtimeRoot: (implementation: string, version: string, backend?: string) => string
  }
  runtime: Pick<ClawctlRuntimeApi, "pingText" | "prepareRuntime" | "runChatDirect">
  store: {
    readRuntimeRecord: (
      implementation: string,
      version: string,
      backend?: string,
    ) => Effect.Effect<RuntimeRecord | undefined, ClawctlError>
    resolveInstalledRecord: (
      implementation: string,
      version?: string,
      backend?: string,
    ) => Effect.Effect<InstallRecord, ClawctlError>
    writeRuntimeRecord: (record: RuntimeRecord) => Effect.Effect<void, ClawctlError>
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function currentProgramCommand(): { args: string[]; command: string } {
  const sourceEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts")
  if (existsSync(sourceEntrypoint)) {
    return {
      command: process.execPath,
      args: [sourceEntrypoint],
    }
  }

  return {
    command: process.execPath,
    args: [],
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function normalizeRuntimeRecord(record: RuntimeRecord, input: Partial<RuntimeRecord>): RuntimeRecord {
  return {
    ...record,
    ...input,
    updatedAt: nowIso(),
  }
}

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

function logExcerpt(source: string): string | undefined {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    return undefined
  }
  return lines.slice(-8).join("\n")
}

export function startupFailureMessage(
  implementation: string,
  detail: string,
  options?: {
    excerpt?: string
    logSource?: string
  },
): string {
  return options?.excerpt
    ? `failed starting runtime for ${implementation}: ${detail}\n${options.excerpt}`
    : `failed starting runtime for ${implementation}: ${detail}`
}

type ResolvedRuntime = {
  readonly registration: RegisteredImplementation & {
    messagingUnavailableReason?: string
    implementationHooks: {
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
      normalizeChatOutput?: (input: { stdout: string; stderr: string }) => string
      renderConfig: (input: { config: Record<string, string>; workspaceDir: string }) => Promise<
        Array<{
          content: string
          path: string
        }>
      >
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
    }
  }
  readonly runtime: RuntimeManifest
}

export const ClawctlRuntimeLive = Layer.effect(
  ClawctlRuntimeService,
  Effect.gen(function* () {
    const commandExecutor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const {
      activeShim,
      implementationShim,
      path,
      paths,
      runtimeHomeDir,
      runtimeLogFile,
      runtimeRoot,
      runtimeStateDir,
      runtimeWorkspaceDir,
    } = yield* ClawctlPathsService
    const store = yield* ClawctlStoreService
    const resolveRegistration = makeResolveRegistration("ClawctlRuntimeService")
    const parseReference = makeParseReference("ClawctlRuntimeService")
    const requireInteractableImplementation = makeRequireInteractableImplementation(
      "ClawctlRuntimeService",
      resolveRegistration,
    )
    const resolveRuntime = Effect.fn("ClawctlRuntimeService.resolveRuntime")(function* (record: InstallRecord) {
      const registration = yield* resolveRegistration(record.implementation)
      const runtime = registration.manifest.backends.find((backend) => backend.kind === record.backend)?.runtime
      if (!runtime) {
        return yield* userError(
          "runtime.resolveRuntime",
          `missing runtime backend for ${record.implementation}:${record.backend}`,
        )
      }
      return {
        registration: registration as ResolvedRuntime["registration"],
        runtime,
      } satisfies ResolvedRuntime
    })
    const resolveSharedConfigEntries = Effect.fn("ClawctlRuntimeService.resolveSharedConfigEntries")(function* () {
      return sharedConfigToEntries(yield* store.readSharedConfig)
    })
    const resolveConfiguredRuntime = Effect.fn("ClawctlRuntimeService.resolveConfiguredRuntime")(function* () {
      const configuredValue = sharedConfigValue(yield* store.readSharedConfig, "CLAW_RUNTIME")?.trim()
      if (!configuredValue || configuredValue.length === 0) {
        return "local" as const
      }
      if (!isRuntimeBackend(configuredValue)) {
        return yield* userError(
          "runtime.resolveConfiguredRuntime",
          `shared config CLAW_RUNTIME must be one of: local, docker (got ${configuredValue})`,
        )
      }
      return configuredValue
    })
    const runDockerStdout = Effect.fn("ClawctlRuntimeService.runDockerStdout")(function* (
      action: string,
      args: ReadonlyArray<string>,
    ) {
      return (yield* withSystemError(
        action,
        commandExecutor.string(Command.make(dockerExecutable(), ...args).pipe(Command.env(process.env))),
      )).trim()
    })
    const runDockerExitCode = Effect.fn("ClawctlRuntimeService.runDockerExitCode")(function* (
      action: string,
      args: ReadonlyArray<string>,
    ) {
      return Number(
        yield* withSystemError(
          action,
          commandExecutor.exitCode(Command.make(dockerExecutable(), ...args).pipe(Command.env(process.env))),
        ),
      )
    })
    const containerNameForRecord = (record: InstallRecord) =>
      `clawctl-${record.implementation}-${record.backend}-${record.resolvedVersion.replaceAll(/[^A-Za-z0-9_.-]+/gu, "-")}`
    const clearShimAt = Effect.fn("ClawctlRuntimeService.clearShimAt")(function* (shimPath: string) {
      const exists = yield* withSystemError("runtime.shimExists", fs.exists(shimPath))
      if (!exists) {
        return
      }
      yield* withSystemError("runtime.removeShim", fs.remove(shimPath))
    })
    const clearActiveShims = Effect.fn("ClawctlRuntimeService.clearActiveShims")(function* (implementation?: string) {
      yield* clearShimAt(activeShim())
      if (implementation) {
        yield* clearShimAt(implementationShim(implementation))
      }
    })
    const updateActiveShims = Effect.fn("ClawctlRuntimeService.updateActiveShims")(function* (
      record: InstallRecord,
      previousImplementation?: string,
    ) {
      const invocation = currentProgramCommand()
      const [command, ...fixedArgs] = [invocation.command, ...invocation.args]
      if (!command) {
        return yield* userError("runtime.updateActiveShims", `missing binary for ${record.implementation}`)
      }

      const wrapper = `#!/bin/sh
CLAWCTL_ROOT=${shellQuote(paths.rootDir)} exec ${[command, ...fixedArgs, shimSentinel, record.implementation].map(shellQuote).join(" ")} "$@"
`

      yield* withSystemError("runtime.makeBinDir", fs.makeDirectory(paths.binDir, { recursive: true }))
      yield* clearActiveShims(previousImplementation)
      if (previousImplementation && previousImplementation !== record.implementation) {
        yield* clearShimAt(implementationShim(record.implementation))
      }
      yield* withSystemError("runtime.writeActiveShim", fs.writeFileString(activeShim(), wrapper))
      yield* withSystemError(
        "runtime.writeImplementationShim",
        fs.writeFileString(implementationShim(record.implementation), wrapper),
      )
      yield* withSystemError(
        "runtime.chmodActiveShim",
        commandExecutor.exitCode(Command.make("chmod", "755", activeShim(), implementationShim(record.implementation))),
      ).pipe(
        Effect.flatMap((exitCode) =>
          Number(exitCode) === 0 ? Effect.void : userError("runtime.updateActiveShims", "failed to chmod shim"),
        ),
      )
    })

    const buildRuntimeRecord = Effect.fn("ClawctlRuntimeService.buildRuntimeRecord")(function* (
      record: InstallRecord,
      input: Partial<RuntimeRecord>,
    ) {
      const current = yield* store.readCurrentSelection
      const active = Boolean(
        current &&
          current.implementation === record.implementation &&
          current.version === record.resolvedVersion &&
          current.backend === record.backend,
      )

      return {
        implementation: record.implementation,
        version: record.resolvedVersion,
        backend: record.backend,
        runtimeRoot: runtimeRoot(record.implementation, record.resolvedVersion, record.backend),
        active,
        managedByClawctl: true,
        proxyMode: "proxy" as const,
        state: "stopped" as const,
        updatedAt: nowIso(),
        ...input,
      } satisfies RuntimeRecord
    })

    const renderRuntimeConfig = Effect.fn("ClawctlRuntimeService.renderRuntimeConfig")(function* (
      record: InstallRecord,
      options?: {
        validateRequiredKeys?: boolean
      },
    ) {
      const config = yield* store.readSharedConfig
      const configEntries = sharedConfigToEntries(config)
      const registration = yield* resolveRegistration(record.implementation)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)

      yield* withSystemError("runtime.makeHomeDir", fs.makeDirectory(homeDir, { recursive: true }))
      yield* withSystemError("runtime.makeWorkspaceDir", fs.makeDirectory(workspaceDir, { recursive: true }))
      yield* withSystemError("runtime.makeStateDir", fs.makeDirectory(stateDir, { recursive: true }))

      if (options?.validateRequiredKeys === true) {
        for (const file of registration.manifest.config.files) {
          const missingKeys = missingSharedConfigKeys(config, file.requiredKeys)
          if (missingKeys.length > 0) {
            return yield* userError(
              "runtime.renderRuntimeConfig",
              `shared config key is missing or placeholder: ${missingKeys[0]}`,
            )
          }
        }
      }

      const renderedFiles = yield* Effect.tryPromise({
        try: () =>
          registration.implementationHooks.renderConfig({
            config: configEntries,
            workspaceDir,
          }),
        catch: (cause) => userError("runtime.renderConfig", String(cause)),
      })

      for (const file of renderedFiles) {
        const destination = path.resolve(homeDir, file.path)
        const parent = path.dirname(destination)
        if (parent.length > 0) {
          yield* withSystemError("runtime.makeConfigDir", fs.makeDirectory(parent, { recursive: true }))
        }
        yield* withSystemError("runtime.writeConfig", fs.writeFileString(destination, file.content))
      }

      yield* withSystemError("runtime.makeRuntimeDir", fs.makeDirectory(runtimeDir, { recursive: true }))
    })
    const readRuntimeLogText = Effect.fn("ClawctlRuntimeService.readRuntimeLogText")(function* (record: InstallRecord) {
      if (record.backend === "docker") {
        const runtimeRecord = yield* store.readRuntimeRecord(
          record.implementation,
          record.resolvedVersion,
          record.backend,
        )
        if (!runtimeRecord) {
          return undefined
        }
        const logs = yield* readDockerLogs(record, runtimeRecord)
        return logs.length > 0 ? logs : undefined
      }
      const logFile = runtimeLogFile(record.implementation, record.resolvedVersion, record.backend)
      const exists = yield* withSystemError("runtime.logExists", fs.exists(logFile))
      if (!exists) {
        return undefined
      }
      return yield* withSystemError("runtime.readLog", fs.readFileString(logFile)).pipe(
        Effect.catchAll(() => Effect.void),
      )
    })
    const readRuntimeLogExcerpt = Effect.fn("ClawctlRuntimeService.readRuntimeLogExcerpt")(function* (
      record: InstallRecord,
    ) {
      const source = yield* readRuntimeLogText(record)
      if (source === undefined) {
        return undefined
      }
      return logExcerpt(source)
    })
    const readRuntimeLogSource = readRuntimeLogText

    const runNativeStatus = Effect.fn("ClawctlRuntimeService.runNativeStatus")(function* (
      record: InstallRecord,
      runtimeRecord: RuntimeRecord,
    ) {
      const { registration, runtime } = yield* resolveRuntime(record)
      if (runtime.supervision.kind !== "native-daemon") {
        return false
      }
      if (!registration.implementationHooks.status) {
        return yield* userError(
          "runtime.runNativeStatus",
          `native-daemon adapter is missing a status hook: ${record.implementation}`,
        )
      }

      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)
      const configEntries = yield* resolveSharedConfigEntries()
      return yield* Effect.tryPromise({
        try: () =>
          registration.implementationHooks.status?.({
            backend: record.backend,
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
            entrypointCommand: record.entrypointCommand,
            installRoot: record.installRoot,
            homeDir,
            record: {
              implementation: record.implementation,
              resolvedVersion: record.resolvedVersion,
            },
            runtimeDir,
            stateDir,
            workspaceDir,
            ...(runtimeRecord.port === undefined ? {} : { port: runtimeRecord.port }),
          }) ?? Promise.resolve(false),
        catch: (cause) => userError("runtime.runNativeStatus", cause instanceof Error ? cause.message : String(cause)),
      })
    })

    const resolveChatTarget = Effect.fn("ClawctlRuntimeService.resolveChatTarget")(function* (
      target: Option.Option<string>,
    ) {
      const resolvedTarget = target._tag === "Some" ? target.value : undefined
      const current = yield* store.readCurrentSelection
      if (resolvedTarget) {
        const parsed = yield* parseReference(resolvedTarget)
        const backend =
          current &&
          current.implementation === parsed.implementation &&
          (parsed.version === undefined || current.version === parsed.version)
            ? current.backend
            : yield* resolveConfiguredRuntime()
        return yield* store
          .resolveInstalledRecord(parsed.implementation, parsed.version, backend)
          .pipe(Effect.catchAll(() => store.resolveInstalledRecord(parsed.implementation, parsed.version)))
      }
      if (!current) {
        return yield* userError("runtime.resolveChatTarget", "no active claw selected")
      }
      return yield* store.resolveInstalledRecord(current.implementation, current.version, current.backend)
    })

    const writeRuntimeState = Effect.fn("ClawctlRuntimeService.writeRuntimeState")(function* (
      record: InstallRecord,
      next: Partial<RuntimeRecord>,
    ) {
      const existing = yield* store.readRuntimeRecord(record.implementation, record.resolvedVersion, record.backend)
      const base = existing ?? (yield* buildRuntimeRecord(record, {}))
      yield* store.writeRuntimeRecord(normalizeRuntimeRecord(base, next))
    })

    const repairPythonEntrypoints = Effect.fn("ClawctlRuntimeService.repairPythonEntrypoints")(function* (
      record: InstallRecord,
    ) {
      if (record.installStrategy === "repo-bootstrap") {
        const rewriteTextFile = Effect.fn("ClawctlRuntimeService.repairRepoBootstrapTextFile")(function* (
          filePath: string,
          executable = false,
        ) {
          const exists = yield* withSystemError("runtime.statRepoBootstrapPath", fs.exists(filePath))
          if (!exists) {
            return
          }
          const source = yield* withSystemError("runtime.readRepoBootstrapPath", fs.readFileString(filePath))
          const repaired = repairInstallRootReference(source, record.installRoot)
          if (repaired === source) {
            return
          }
          yield* withSystemError("runtime.writeRepoBootstrapPath", fs.writeFileString(filePath, repaired))
          if (executable) {
            yield* withSystemError("runtime.chmodRepoBootstrapPath", fs.chmod(filePath, 0o755))
          }
        })

        const venvRoot = path.resolve(record.installRoot, "repo", "venv")
        const binDir = path.resolve(venvRoot, "bin")
        const binDirExists = yield* withSystemError("runtime.statRepoBootstrapBinDir", fs.exists(binDir))
        if (binDirExists) {
          const binEntries = yield* withSystemError("runtime.readRepoBootstrapBinDir", fs.readDirectory(binDir))
          for (const entry of binEntries) {
            yield* rewriteTextFile(path.resolve(binDir, entry), true)
          }
        }

        const libDir = path.resolve(venvRoot, "lib")
        const libDirExists = yield* withSystemError("runtime.statRepoBootstrapLibDir", fs.exists(libDir))
        if (!libDirExists) {
          return
        }

        const pythonDirs = yield* withSystemError("runtime.readRepoBootstrapLibDir", fs.readDirectory(libDir))
        for (const pythonDir of pythonDirs) {
          const sitePackagesDir = path.resolve(libDir, pythonDir, "site-packages")
          const sitePackagesExists = yield* withSystemError(
            "runtime.statRepoBootstrapSitePackages",
            fs.exists(sitePackagesDir),
          )
          if (!sitePackagesExists) {
            continue
          }
          const sitePackagesEntries = yield* withSystemError(
            "runtime.readRepoBootstrapSitePackages",
            fs.readDirectory(sitePackagesDir),
          )
          for (const entry of sitePackagesEntries) {
            if (entry.endsWith(".pth") || (entry.startsWith("__editable__") && entry.endsWith(".py"))) {
              yield* rewriteTextFile(path.resolve(sitePackagesDir, entry))
              continue
            }
            if (entry.endsWith(".dist-info")) {
              yield* rewriteTextFile(path.resolve(sitePackagesDir, entry, "direct_url.json"))
            }
          }
        }
        return
      }

      if (record.installStrategy !== "python-package") {
        return
      }
      const [entrypoint] = record.entrypointCommand
      if (!entrypoint) {
        return
      }

      const entrypointName = basename(entrypoint)
      const installedInterpreterDir = path.resolve(record.installRoot, "venv", "bin")
      const scriptPaths = [path.resolve(record.installRoot, "venv", "bin", entrypointName), entrypoint]

      for (const scriptPath of scriptPaths) {
        const exists = yield* withSystemError("runtime.statPythonEntrypoint", fs.exists(scriptPath))
        if (!exists) {
          continue
        }
        const source = yield* withSystemError("runtime.readPythonEntrypoint", fs.readFileString(scriptPath))
        const repaired = repairPythonScriptShebang(source, installedInterpreterDir)
        if (repaired !== source) {
          yield* withSystemError("runtime.writePythonEntrypoint", fs.writeFileString(scriptPath, repaired))
          yield* withSystemError("runtime.chmodPythonEntrypoint", fs.chmod(scriptPath, 0o755))
        }
      }
    })
    const buildDockerStartInvocation = Effect.fn("ClawctlRuntimeService.buildDockerStartInvocation")(function* (
      record: InstallRecord,
      resolved: ResolvedRuntime,
    ) {
      const configEntries = yield* resolveSharedConfigEntries()
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      const env = resolved.registration.implementationHooks.runtimeEnv({
        backend: record.backend,
        config: configEntries,
        homeDir,
        entrypointCommand: record.entrypointCommand,
        installRoot: record.installRoot,
        runtimeDir,
        stateDir,
        workspaceDir,
      })

      if (resolved.runtime.entrypoint.kind === "exec") {
        return {
          args: resolved.runtime.entrypoint.command.slice(1),
          command: resolved.runtime.entrypoint.command[0] ?? "",
          env,
          port: undefined,
        }
      }

      if (!resolved.registration.implementationHooks.start) {
        return yield* userError(
          "runtime.buildDockerStartInvocation",
          `docker backend entrypoint hook is missing a start hook: ${record.implementation}`,
        )
      }

      return yield* Effect.tryPromise({
        try: () =>
          resolved.registration.implementationHooks.start?.({
            backend: record.backend,
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
            entrypointCommand: record.entrypointCommand,
            installRoot: record.installRoot,
            homeDir,
            record: {
              implementation: record.implementation,
              resolvedVersion: record.resolvedVersion,
            },
            runtimeDir,
            stateDir,
            workspaceDir,
          }) ?? Promise.reject(new Error("missing start hook")),
        catch: (cause) =>
          userError("runtime.buildDockerStartInvocation", cause instanceof Error ? cause.message : String(cause)),
      })
    })
    const buildDockerChatCommand = Effect.fn("ClawctlRuntimeService.buildDockerChatCommand")(function* (
      record: InstallRecord,
      runtimeRecord: RuntimeRecord | undefined,
      message: string,
    ) {
      const { registration, runtime } = yield* resolveRuntime(record)
      const configEntries = yield* resolveSharedConfigEntries()
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)

      if (runtime.chat.kind === "argv") {
        return [...runtime.chat.command, message]
      }

      return yield* Effect.try({
        try: () =>
          registration.implementationHooks.buildChatCommand({
            backend: record.backend,
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
            entrypointCommand: record.entrypointCommand,
            installRoot: record.installRoot,
            homeDir,
            message,
            runtimeDir,
            stateDir,
            workspaceDir,
            ...(runtimeRecord?.port === undefined ? {} : { port: runtimeRecord.port }),
          }),
        catch: (cause) =>
          userError("runtime.buildDockerChatCommand", cause instanceof Error ? cause.message : String(cause)),
      })
    })
    const dockerContainerRef = (record: InstallRecord, runtimeRecord: RuntimeRecord) =>
      runtimeRecord.containerId ?? runtimeRecord.containerName ?? containerNameForRecord(record)
    const dockerContainerRunning = Effect.fn("ClawctlRuntimeService.dockerContainerRunning")(function* (
      record: InstallRecord,
      runtimeRecord: RuntimeRecord,
    ) {
      const ref = dockerContainerRef(record, runtimeRecord)
      const stdout = yield* runDockerStdout("runtime.dockerInspectRunning", [
        "inspect",
        "-f",
        "{{json .State.Running}}",
        ref,
      ]).pipe(Effect.catchAll(() => Effect.succeed("false")))
      return stdout === "true"
    })
    const readDockerLogs = Effect.fn("ClawctlRuntimeService.readDockerLogs")(function* (
      record: InstallRecord,
      runtimeRecord: RuntimeRecord,
    ) {
      const ref = dockerContainerRef(record, runtimeRecord)
      return yield* runDockerStdout("runtime.dockerLogs", ["logs", ref]).pipe(Effect.catchAll(() => Effect.succeed("")))
    })

    const readHealthyRuntimeRecord = Effect.fn("ClawctlRuntimeService.readHealthyRuntimeRecord")(function* (
      record: InstallRecord,
    ) {
      const runtimeRecord = yield* store.readRuntimeRecord(
        record.implementation,
        record.resolvedVersion,
        record.backend,
      )
      if (!runtimeRecord) {
        return undefined
      }

      if (runtimeRecord.pid !== undefined && !processAlive(runtimeRecord.pid)) {
        const stoppedRecord = normalizeRuntimeRecord(runtimeRecord, {
          active: false,
          lastError: runtimeRecord.lastError ?? "process exited",
          state: "stopped",
          stoppedAt: nowIso(),
        })
        yield* store.writeRuntimeRecord(stoppedRecord)
        return stoppedRecord
      }

      if (record.backend === "docker") {
        const running = yield* dockerContainerRunning(record, runtimeRecord)
        if (!running) {
          const stoppedRecord = normalizeRuntimeRecord(runtimeRecord, {
            active: false,
            lastError: runtimeRecord.lastError ?? "container exited",
            state: "stopped",
            stoppedAt: nowIso(),
          })
          yield* store.writeRuntimeRecord(stoppedRecord)
          return stoppedRecord
        }
        if (runtimeRecord.state !== "running") {
          const runningRecord = normalizeRuntimeRecord(runtimeRecord, {
            active: true,
            state: "running",
          })
          yield* store.writeRuntimeRecord(runningRecord)
          return runningRecord
        }
        return runtimeRecord
      }

      const { runtime } = yield* resolveRuntime(record)
      if (runtime.supervision.kind === "native-daemon") {
        const healthy = yield* runNativeStatus(record, runtimeRecord).pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (healthy && runtimeRecord.state !== "running") {
          const runningRecord = normalizeRuntimeRecord(runtimeRecord, {
            active: true,
            state: "running",
          })
          yield* store.writeRuntimeRecord(runningRecord)
          return runningRecord
        }
        if (!healthy && runtimeRecord.state === "running") {
          const failedRecord = normalizeRuntimeRecord(runtimeRecord, {
            active: true,
            lastError: "health check failed",
            state: "failed",
          })
          yield* store.writeRuntimeRecord(failedRecord)
          return failedRecord
        }
      }

      return runtimeRecord
    })

    const requestDaemon = Effect.fn("ClawctlRuntimeService.requestDaemon")(function* (
      record: InstallRecord,
      pathname: "/chat" | "/ping" | "/health",
      body?: Record<string, string>,
    ) {
      const runtimeRecord = yield* readHealthyRuntimeRecord(record)
      if (!runtimeRecord?.port || runtimeRecord.state !== "running") {
        return yield* userError("runtime.requestDaemon", `runtime is not running: ${record.implementation}`)
      }

      const response = yield* Effect.tryPromise({
        try: () => {
          const init = body
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : { method: "GET" }
          return fetch(`http://127.0.0.1:${runtimeRecord.port}${pathname}`, init)
        },
        catch: (cause) => userError("runtime.requestDaemon", cause instanceof Error ? cause.message : String(cause)),
      })
      if (!response.ok) {
        return yield* userError("runtime.requestDaemon", `runtime request failed: ${response.status}`)
      }
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ output?: string; state?: string }>,
        catch: (cause) => userError("runtime.requestDaemon", cause instanceof Error ? cause.message : String(cause)),
      })
    })

    const runChatDirect = Effect.fn("ClawctlRuntimeService.runChatDirect")(function* (
      record: InstallRecord,
      message: string,
      runtimeRecord?: RuntimeRecord,
    ) {
      yield* store.ensureSharedConfig
      yield* renderRuntimeConfig(record, { validateRequiredKeys: true })

      const { registration } = yield* resolveRuntime(record)
      const configEntries = yield* resolveSharedConfigEntries()
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      if (registration.implementationHooks.chat) {
        return yield* Effect.tryPromise({
          try: () =>
            registration.implementationHooks.chat?.({
              backend: record.backend,
              binaryPath: record.entrypointCommand[0] ?? "",
              config: configEntries,
              entrypointCommand: record.entrypointCommand,
              installRoot: record.installRoot,
              homeDir,
              message,
              runtimeDir,
              stateDir,
              workspaceDir,
              ...(runtimeRecord?.port === undefined ? {} : { port: runtimeRecord.port }),
            }) ?? Promise.reject(new Error("missing chat hook")),
          catch: (cause) => userError("runtime.chatHook", cause instanceof Error ? cause.message : String(cause)),
        })
      }
      const commandArgs = yield* Effect.try({
        try: () =>
          registration.implementationHooks.buildChatCommand({
            backend: record.backend,
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
            entrypointCommand: record.entrypointCommand,
            installRoot: record.installRoot,
            homeDir,
            message,
            runtimeDir,
            stateDir,
            workspaceDir,
            ...(runtimeRecord?.port === undefined ? {} : { port: runtimeRecord.port }),
          }),
        catch: (cause) => userError("runtime.buildChatCommand", cause instanceof Error ? cause.message : String(cause)),
      })
      const [file, ...args] = commandArgs
      if (!file) {
        return yield* userError("runtime.runChatDirect", `missing binary for ${record.implementation}`)
      }
      if (file.includes("/")) {
        const exists = yield* withSystemError("runtime.binaryExists", fs.exists(file))
        if (!exists) {
          return yield* userError("runtime.runChatDirect", `missing binary for ${record.implementation}`)
        }
      }

      const env = {
        ...process.env,
        ...(yield* Effect.try({
          try: () =>
            registration.implementationHooks.runtimeEnv({
              backend: record.backend,
              config: configEntries,
              homeDir,
              entrypointCommand: record.entrypointCommand,
              installRoot: record.installRoot,
              runtimeDir,
              stateDir,
              workspaceDir,
              ...(runtimeRecord?.port === undefined ? {} : { port: runtimeRecord.port }),
            }),
          catch: (cause) => userError("runtime.runtimeEnv", cause instanceof Error ? cause.message : String(cause)),
        })),
      }

      const stdout = yield* withSystemError(
        "runtime.runCommand",
        commandExecutor.string(
          Command.make(file, ...args).pipe(Command.env(env), Command.workingDirectory(workspaceDir)),
        ),
      )
      const normalized = registration.implementationHooks.normalizeChatOutput
        ? yield* Effect.try({
            try: () =>
              registration.implementationHooks.normalizeChatOutput?.({
                stdout,
                stderr: "",
              }),
            catch: (cause) =>
              userError("runtime.normalizeChatOutput", cause instanceof Error ? cause.message : String(cause)),
          })
        : undefined
      return normalized?.trim() ?? stdout.trim()
    })

    const spawnNativeDaemonRuntime = Effect.fn("ClawctlRuntimeService.spawnNativeDaemonRuntime")(function* (
      record: InstallRecord,
      registration: ResolvedRuntime["registration"],
    ) {
      const existing = yield* readHealthyRuntimeRecord(record)
      if (existing?.state === "running") {
        return existing
      }

      if (!registration.implementationHooks.start) {
        return yield* userError(
          "runtime.spawnNativeDaemonRuntime",
          `native-daemon adapter is missing a start hook: ${record.implementation}`,
        )
      }

      yield* store.ensureSharedConfig
      yield* renderRuntimeConfig(record)

      const logFile = runtimeLogFile(record.implementation, record.resolvedVersion, record.backend)
      const parent = path.dirname(logFile)
      yield* withSystemError("runtime.makeLogDir", fs.makeDirectory(parent, { recursive: true }))

      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      const configEntries = yield* resolveSharedConfigEntries()
      const start = yield* Effect.tryPromise({
        try: () =>
          registration.implementationHooks.start?.({
            backend: record.backend,
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
            entrypointCommand: record.entrypointCommand,
            installRoot: record.installRoot,
            homeDir,
            record: {
              implementation: record.implementation,
              resolvedVersion: record.resolvedVersion,
            },
            runtimeDir,
            stateDir,
            workspaceDir,
          }) ?? Promise.reject(new Error("missing start hook")),
        catch: (cause) =>
          userError("runtime.spawnNativeDaemonRuntime", cause instanceof Error ? cause.message : String(cause)),
      })

      const fd = yield* Effect.try({
        try: () => openSync(logFile, "a"),
        catch: (cause) => userError("runtime.spawnNativeDaemonRuntime", String(cause)),
      })

      const child = yield* Effect.try({
        try: () =>
          spawn(start.command, start.args, {
            cwd: workspaceDir,
            detached: true,
            env: {
              ...process.env,
              ...start.env,
              CLAWCTL_ROOT: paths.rootDir,
            },
            stdio: ["ignore", fd, fd],
          }),
        catch: (cause) => userError("runtime.spawnNativeDaemonRuntime", String(cause)),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            closeSync(fd)
          }),
        ),
      )

      child.unref()

      const initialRuntimeRecord = yield* buildRuntimeRecord(record, {
        active: true,
        managedByClawctl: true,
        proxyMode: "native-daemon",
        startedAt: nowIso(),
        state: "starting",
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        ...(start.port === undefined ? {} : { port: start.port }),
      })
      yield* store.writeRuntimeRecord(initialRuntimeRecord)

      const waitForReady = (remaining: number): Effect.Effect<RuntimeRecord, ClawctlError> =>
        Effect.gen(function* () {
          const runtimeRecord = yield* readHealthyRuntimeRecord(record)
          if (runtimeRecord?.state === "running") {
            return runtimeRecord
          }
          if (runtimeRecord?.state === "stopped" || runtimeRecord?.state === "failed") {
            const detail = runtimeRecord.lastError ?? `runtime ${runtimeRecord.state}`
            const logSource = yield* readRuntimeLogSource(record)
            const excerpt = yield* readRuntimeLogExcerpt(record)
            const messageOptions = {
              ...(excerpt ? { excerpt } : {}),
              ...(logSource ? { logSource } : {}),
            }
            return yield* userError(
              "runtime.spawnNativeDaemonRuntime",
              startupFailureMessage(record.implementation, detail, messageOptions),
            )
          }
          if (remaining <= 0) {
            return yield* userError(
              "runtime.spawnNativeDaemonRuntime",
              `timed out starting runtime for ${record.implementation}`,
            )
          }
          yield* Effect.sleep(daemonStartupSleep)
          return yield* waitForReady(remaining - 1)
        })

      return yield* waitForReady(daemonStartupPolls)
    })
    const spawnManagedContainerRuntime = Effect.fn("ClawctlRuntimeService.spawnManagedContainerRuntime")(function* (
      record: InstallRecord,
    ) {
      const existing = yield* readHealthyRuntimeRecord(record)
      if (existing?.state === "running") {
        return existing
      }

      yield* store.ensureSharedConfig
      yield* renderRuntimeConfig(record)

      const resolved = yield* resolveRuntime(record)
      const start = yield* buildDockerStartInvocation(record, resolved)
      const image = record.containerImage
      if (!image) {
        return yield* userError(
          "runtime.spawnManagedContainerRuntime",
          `docker install is missing a container image reference: ${record.implementation}`,
        )
      }

      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      const containerName = containerNameForRecord(record)
      yield* runDockerExitCode("runtime.removeExistingContainer", ["rm", "-f", containerName]).pipe(
        Effect.catchAll(() => Effect.succeed(0)),
      )

      const envArgs = Object.entries({
        ...process.env,
        ...start.env,
        CLAWCTL_ROOT: paths.rootDir,
      }).flatMap(([key, value]) => (value === undefined ? [] : ["-e", `${key}=${value}`]))

      const containerId = yield* runDockerStdout("runtime.spawnManagedContainerRuntime", [
        "run",
        "-d",
        "--name",
        containerName,
        "-w",
        workspaceDir,
        "-v",
        `${runtimeDir}:${runtimeDir}`,
        ...envArgs,
        image,
        start.command,
        ...start.args,
      ])
      if (containerId.length === 0) {
        return yield* userError(
          "runtime.spawnManagedContainerRuntime",
          `failed to start docker runtime for ${record.implementation}`,
        )
      }

      const initialRuntimeRecord = yield* buildRuntimeRecord(record, {
        active: true,
        containerId,
        containerName,
        managedByClawctl: true,
        proxyMode: "container",
        startedAt: nowIso(),
        state: "starting",
      })
      yield* store.writeRuntimeRecord(initialRuntimeRecord)

      const waitForReady = (remaining: number): Effect.Effect<RuntimeRecord, ClawctlError> =>
        Effect.gen(function* () {
          const runtimeRecord = yield* readHealthyRuntimeRecord(record)
          if (runtimeRecord?.state === "running") {
            return runtimeRecord
          }
          if (runtimeRecord?.state === "stopped" || runtimeRecord?.state === "failed") {
            const detail = runtimeRecord.lastError ?? `runtime ${runtimeRecord.state}`
            const logSource = yield* readRuntimeLogSource(record)
            const excerpt = yield* readRuntimeLogExcerpt(record)
            const messageOptions = {
              ...(excerpt ? { excerpt } : {}),
              ...(logSource ? { logSource } : {}),
            }
            return yield* userError(
              "runtime.spawnManagedContainerRuntime",
              startupFailureMessage(record.implementation, detail, messageOptions),
            )
          }
          if (remaining <= 0) {
            return yield* userError(
              "runtime.spawnManagedContainerRuntime",
              `timed out starting runtime for ${record.implementation}`,
            )
          }
          yield* Effect.sleep(daemonStartupSleep)
          return yield* waitForReady(remaining - 1)
        })

      return yield* waitForReady(daemonStartupPolls)
    })

    const spawnManagedRuntime = Effect.fn("ClawctlRuntimeService.spawnManagedRuntime")(function* (
      record: InstallRecord,
    ) {
      if (record.backend === "docker") {
        return yield* spawnManagedContainerRuntime(record)
      }
      yield* repairPythonEntrypoints(record)
      const { registration, runtime } = yield* resolveRuntime(record)
      if (runtime.supervision.kind === "native-daemon") {
        return yield* spawnNativeDaemonRuntime(record, registration)
      }

      const existing = yield* readHealthyRuntimeRecord(record)
      if (existing?.state === "running" && existing.port !== undefined) {
        return existing
      }

      yield* store.ensureSharedConfig
      yield* renderRuntimeConfig(record)

      const logFile = runtimeLogFile(record.implementation, record.resolvedVersion, record.backend)
      const parent = path.dirname(logFile)
      yield* withSystemError("runtime.makeLogDir", fs.makeDirectory(parent, { recursive: true }))

      const invocation = currentProgramCommand()
      const fd = yield* Effect.try({
        try: () => openSync(logFile, "a"),
        catch: (cause) => userError("runtime.spawnManagedRuntime", String(cause)),
      })

      const child = yield* Effect.try({
        try: () =>
          spawn(
            invocation.command,
            [...invocation.args, daemonSentinel, record.implementation, record.resolvedVersion, record.backend],
            {
              detached: true,
              env: {
                ...process.env,
                CLAWCTL_ROOT: paths.rootDir,
              },
              stdio: ["ignore", fd, fd],
            },
          ),
        catch: (cause) => userError("runtime.spawnManagedRuntime", String(cause)),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            closeSync(fd)
          }),
        ),
      )

      child.unref()

      const initialRuntimeRecord = {
        active: true,
        managedByClawctl: true,
        proxyMode: "proxy",
        startedAt: nowIso(),
        state: "starting",
        ...(child.pid === undefined ? {} : { pid: child.pid }),
      } satisfies Partial<RuntimeRecord>
      yield* store.writeRuntimeRecord(yield* buildRuntimeRecord(record, initialRuntimeRecord))

      const waitForReady = (remaining: number): Effect.Effect<RuntimeRecord, ClawctlError> =>
        Effect.gen(function* () {
          const runtimeRecord = yield* readHealthyRuntimeRecord(record)
          if (runtimeRecord?.state === "running" && runtimeRecord.port !== undefined) {
            return runtimeRecord
          }
          if (runtimeRecord?.state === "stopped" || runtimeRecord?.state === "failed") {
            const detail = runtimeRecord.lastError ?? `runtime ${runtimeRecord.state}`
            const logSource = yield* readRuntimeLogSource(record)
            const excerpt = yield* readRuntimeLogExcerpt(record)
            const messageOptions = {
              ...(excerpt ? { excerpt } : {}),
              ...(logSource ? { logSource } : {}),
            }
            return yield* userError(
              "runtime.spawnManagedRuntime",
              startupFailureMessage(record.implementation, detail, messageOptions),
            )
          }
          if (remaining <= 0) {
            return yield* userError(
              "runtime.spawnManagedRuntime",
              `timed out starting runtime for ${record.implementation}`,
            )
          }
          yield* Effect.sleep(daemonStartupSleep)
          return yield* waitForReady(remaining - 1)
        })

      return yield* waitForReady(daemonStartupPolls)
    })

    const stopInstalledRecord = Effect.fn("ClawctlRuntimeService.stopInstalledRecord")(function* (
      record: InstallRecord,
    ) {
      const runtimeRecord = yield* store.readRuntimeRecord(
        record.implementation,
        record.resolvedVersion,
        record.backend,
      )
      if (!runtimeRecord) {
        return false
      }
      if (record.backend === "docker") {
        const ref = dockerContainerRef(record, runtimeRecord)
        const exitCode = yield* runDockerExitCode("runtime.stopDockerContainer", ["rm", "-f", ref]).pipe(
          Effect.catchAll(() => Effect.succeed(1)),
        )
        yield* store.writeRuntimeRecord(
          normalizeRuntimeRecord(runtimeRecord, {
            active: false,
            state: "stopped",
            stoppedAt: nowIso(),
          }),
        )
        return exitCode === 0
      }
      const pid = runtimeRecord.pid

      if (pid !== undefined && processAlive(pid)) {
        yield* Effect.sync(() => {
          try {
            process.kill(pid, "SIGTERM")
          } catch {
            return
          }
        })
      }

      const waitForExit = (remaining: number): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          if (pid === undefined || !processAlive(pid)) {
            return
          }
          if (remaining <= 0) {
            return
          }
          yield* Effect.sleep(daemonStartupSleep)
          return yield* waitForExit(remaining - 1)
        })

      yield* waitForExit(daemonStartupPolls)
      yield* store.writeRuntimeRecord(
        normalizeRuntimeRecord(runtimeRecord, {
          active: false,
          state: "stopped",
          stoppedAt: nowIso(),
        }),
      )
      return true
    })

    const activateSelection = Effect.fn("ClawctlRuntimeService.activateSelection")(function* (target: TargetReference) {
      yield* requireInteractableImplementation(target.implementation, "activateSelection")
      const backend = target.backend ?? (yield* resolveConfiguredRuntime())
      const record = yield* store.resolveInstalledRecord(target.implementation, target.version, backend)
      const current = yield* store.readCurrentSelection
      const previousImplementation = current?.implementation
      if (
        current &&
        (current.implementation !== record.implementation ||
          current.version !== record.resolvedVersion ||
          current.backend !== record.backend)
      ) {
        const currentRecord = yield* store
          .resolveInstalledRecord(current.implementation, current.version, current.backend)
          .pipe(Effect.catchAll(() => Effect.void))
        if (currentRecord) {
          yield* stopInstalledRecord(currentRecord)
        }
      }

      yield* spawnManagedRuntime(record)
      yield* updateActiveShims(record, previousImplementation).pipe(
        Effect.catchAll((error) =>
          stopInstalledRecord(record).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(Effect.fail(error)),
          ),
        ),
      )
      yield* store.writeCurrentSelection({
        implementation: record.implementation,
        version: record.resolvedVersion,
        backend: record.backend,
      })
      yield* writeRuntimeState(record, {
        active: true,
        state: "running",
      })
      return record
    })

    const ensureActiveChatTarget = Effect.fn("ClawctlRuntimeService.ensureActiveChatTarget")(function* (
      target: Option.Option<string>,
      capability: "chat" | "ping" = "chat",
    ) {
      if (target._tag === "Some") {
        const parsed = yield* parseReference(target.value)
        yield* requireInteractableImplementation(parsed.implementation, "ensureActiveChatTarget")
      }
      const record = yield* resolveChatTarget(target)
      const registration = yield* requireInteractableImplementation(record.implementation, "ensureActiveChatTarget")
      if (!registration.manifest.capabilities[capability]) {
        const reason = (registration as { messagingUnavailableReason?: string }).messagingUnavailableReason
        const detail = reason ? ` (${reason})` : ""
        return yield* userError(
          "runtime.ensureActiveChatTarget",
          `implementation does not support ${capability}: ${record.implementation}${detail}`,
        )
      }
      return yield* activateSelection({
        implementation: record.implementation,
        backend: record.backend,
        version: record.resolvedVersion,
      })
    })

    const requestChat = Effect.fn("ClawctlRuntimeService.requestChat")(function* (
      record: InstallRecord,
      message: string,
    ) {
      const runtimeRecord = yield* spawnManagedRuntime(record)
      if (record.backend === "docker") {
        const { runtime, registration } = yield* resolveRuntime(record)
        if (runtime.chat.kind === "http") {
          const response = yield* requestDaemon(record, "/chat", { message })
          const output = response.output?.trim()
          if (!output) {
            return yield* userError("runtime.requestChat", `runtime returned no output: ${record.implementation}`)
          }
          return output
        }

        const commandArgs = yield* buildDockerChatCommand(record, runtimeRecord, message)
        const [file, ...args] = commandArgs
        if (!file) {
          return yield* userError("runtime.requestChat", `runtime returned no command: ${record.implementation}`)
        }
        const containerRef = dockerContainerRef(record, runtimeRecord)
        const stdout = yield* runDockerStdout("runtime.requestDockerChat", ["exec", containerRef, file, ...args])
        if (registration.implementationHooks.normalizeChatOutput) {
          return yield* Effect.try({
            try: () =>
              registration.implementationHooks.normalizeChatOutput?.({
                stdout,
                stderr: "",
              }) ?? stdout.trim(),
            catch: (cause) => userError("runtime.requestChat", cause instanceof Error ? cause.message : String(cause)),
          })
        }
        return stdout.trim()
      }
      const { runtime } = yield* resolveRuntime(record)
      if (runtime.supervision.kind === "native-daemon") {
        return yield* runChatDirect(record, message, runtimeRecord)
      }
      const response = yield* requestDaemon(record, "/chat", { message })
      const output = response.output?.trim()
      if (!output) {
        return yield* userError("runtime.requestChat", `runtime returned no output: ${record.implementation}`)
      }
      return output
    })

    const runShimmedCommand = Effect.fn("ClawctlRuntimeService.runShimmedCommand")(function* (
      implementation: string,
      args: ReadonlyArray<string>,
    ) {
      const current = yield* store.readCurrentSelection
      if (!current) {
        return yield* userError("runtime.runShimmedCommand", "no active claw selected")
      }
      if (current.implementation !== implementation) {
        return yield* userError(
          "runtime.runShimmedCommand",
          `shim target is not active: ${implementation} (active: ${current.implementation})`,
        )
      }

      const record = yield* store.resolveInstalledRecord(current.implementation, current.version, current.backend)
      yield* repairPythonEntrypoints(record)
      const { registration, runtime } = yield* resolveRuntime(record)
      if (isInstallOnlyRegistration(registration)) {
        return yield* userError("runtime.runShimmedCommand", installOnlyInteractionMessage(record.implementation))
      }
      const configEntries = yield* resolveSharedConfigEntries()
      const runtimeRecord = yield* readHealthyRuntimeRecord(record)
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion, record.backend)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion, record.backend)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion, record.backend)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion, record.backend)
      yield* renderRuntimeConfig(record)

      const env = {
        ...process.env,
        ...(yield* Effect.try({
          try: () =>
            registration.implementationHooks.runtimeEnv({
              backend: record.backend,
              config: configEntries,
              homeDir,
              entrypointCommand: record.entrypointCommand,
              installRoot: record.installRoot,
              runtimeDir,
              stateDir,
              workspaceDir,
              ...(runtimeRecord?.port === undefined ? {} : { port: runtimeRecord.port }),
            }),
          catch: (cause) =>
            userError("runtime.runShimmedCommand", cause instanceof Error ? cause.message : String(cause)),
        })),
        CLAWCTL_ROOT: paths.rootDir,
      }

      const command =
        registration.implementationHooks.buildShimCommand?.({
          backend: record.backend,
          binaryPath: record.entrypointCommand[0] ?? "",
          config: configEntries,
          entrypointCommand: record.entrypointCommand,
          homeDir,
          installRoot: record.installRoot,
          runtimeDir,
          stateDir,
          workspaceDir,
          ...(runtimeRecord?.port === undefined ? {} : { port: runtimeRecord.port }),
          args,
        }) ?? record.entrypointCommand

      if (record.backend === "docker") {
        const runtimeRecord = yield* spawnManagedRuntime(record)
        const containerRef = dockerContainerRef(record, runtimeRecord)
        const baseCommand =
          command.length > 0 ? command : runtime.entrypoint.kind === "exec" ? runtime.entrypoint.command : []
        const [file, ...fixedArgs] = baseCommand
        if (!file) {
          return yield* userError(
            "runtime.runShimmedCommand",
            `implementation does not expose a direct shim command: ${record.implementation}`,
          )
        }
        const child = yield* Effect.try({
          try: () =>
            spawn(dockerExecutable(), ["exec", containerRef, file, ...fixedArgs, ...args], { stdio: "inherit" }),
          catch: (cause) => userError("runtime.runShimmedCommand", String(cause)),
        })
        return yield* Effect.tryPromise({
          try: () =>
            new Promise<number>((resolvePromise, reject) => {
              child.once("error", reject)
              child.once("exit", (code) => {
                resolvePromise(code ?? 1)
              })
            }),
          catch: (cause) => userError("runtime.runShimmedCommand", String(cause)),
        })
      }

      const [file, ...fixedArgs] = command
      if (!file) {
        return yield* userError(
          "runtime.runShimmedCommand",
          `implementation does not expose a direct shim command: ${record.implementation}`,
        )
      }

      const child = yield* Effect.try({
        try: () =>
          spawn(file, [...fixedArgs, ...args], {
            cwd: workspaceDir,
            env,
            stdio: "inherit",
          }),
        catch: (cause) => userError("runtime.runShimmedCommand", String(cause)),
      })
      return yield* Effect.tryPromise({
        try: () =>
          new Promise<number>((resolvePromise, reject) => {
            child.once("error", reject)
            child.once("exit", (code) => {
              resolvePromise(code ?? 1)
            })
          }),
        catch: (cause) => userError("runtime.runShimmedCommand", String(cause)),
      })
    })

    const runtimeState = Effect.fn("ClawctlRuntimeService.runtimeState")(function* (record: InstallRecord) {
      const runtimeRecord = yield* readHealthyRuntimeRecord(record)
      if (!runtimeRecord) {
        const current = yield* store.readCurrentSelection
        return {
          active: Boolean(
            current &&
              current.implementation === record.implementation &&
              current.version === record.resolvedVersion &&
              current.backend === record.backend,
          ),
          managedByClawctl: true,
          state: "stopped" as const,
        } satisfies RuntimeSnapshot
      }

      return {
        active: runtimeRecord.active,
        managedByClawctl: runtimeRecord.managedByClawctl,
        state: runtimeRecord.state,
        ...(runtimeRecord.pid === undefined ? {} : { pid: runtimeRecord.pid }),
        ...(runtimeRecord.port === undefined ? {} : { port: runtimeRecord.port }),
      } satisfies RuntimeSnapshot
    })

    const stopSelection = Effect.fn("ClawctlRuntimeService.stopSelection")(function* (
      target: Option.Option<string>,
      backend?: RuntimeBackend,
    ) {
      const resolvedTarget = target._tag === "Some" ? target.value : undefined
      let record: InstallRecord | undefined
      const current = yield* store.readCurrentSelection
      if (resolvedTarget) {
        const parsed = yield* parseReference(resolvedTarget)
        yield* requireInteractableImplementation(parsed.implementation, "stopSelection")
        record = yield* store.resolveInstalledRecord(
          parsed.implementation,
          parsed.version,
          backend ?? (yield* resolveConfiguredRuntime()),
        )
      } else {
        if (!current) {
          return { stopped: false } satisfies StopSelectionResult
        }
        yield* requireInteractableImplementation(current.implementation, "stopSelection")
        record = yield* store.resolveInstalledRecord(current.implementation, current.version, current.backend)
      }

      const stopped = yield* stopInstalledRecord(record)
      if (
        current &&
        current.implementation === record.implementation &&
        current.version === record.resolvedVersion &&
        current.backend === record.backend
      ) {
        yield* store.clearCurrentSelection
        yield* clearActiveShims(record.implementation)
      }

      return {
        record,
        stopped,
      } satisfies StopSelectionResult
    })

    return ClawctlRuntimeService.of({
      activateSelection,
      ensureActiveChatTarget,
      prepareRuntime: renderRuntimeConfig,
      requestChat,
      runChatDirect,
      runShimmedCommand,
      pingText: () => "Reply with exactly the single word pong.",
      runtimeState,
      stopSelection,
    })
  }),
)

type DaemonArgs = {
  backend: string
  implementation: string
  version: string
}

type ShimArgs = {
  implementation: string
  args: string[]
}

function parseDaemonArgs(argv: string[]): DaemonArgs | undefined {
  const sentinelIndex = argv.indexOf(daemonSentinel)
  if (sentinelIndex < 0) {
    return undefined
  }
  const implementation = argv[sentinelIndex + 1]
  const version = argv[sentinelIndex + 2]
  const backend = argv[sentinelIndex + 3]
  if (!(implementation && version && backend)) {
    return undefined
  }
  return {
    backend,
    implementation,
    version,
  }
}

function parseShimArgs(argv: string[]): ShimArgs | undefined {
  const sentinelIndex = argv.indexOf(shimSentinel)
  if (sentinelIndex < 0) {
    return undefined
  }
  const implementation = argv[sentinelIndex + 1]
  if (!implementation) {
    return undefined
  }
  return {
    implementation,
    args: argv.slice(sentinelIndex + 2),
  }
}

function makeSelfContainedLayer() {
  const baseLayer = BunContext.layer
  const runtimePathsLayer = ClawctlPathsLive.pipe(Layer.provide(baseLayer))
  const runtimeStoreLayer = ClawctlStoreLive.pipe(Layer.provide(Layer.mergeAll(baseLayer, runtimePathsLayer)))
  const runtimeLayer = ClawctlRuntimeLive.pipe(
    Layer.provide(Layer.mergeAll(baseLayer, runtimePathsLayer, runtimeStoreLayer)),
  )
  return Layer.mergeAll(baseLayer, runtimePathsLayer, runtimeStoreLayer, runtimeLayer)
}

export async function maybeRunManagedDaemon(argv: string[]): Promise<boolean> {
  const parsed = parseDaemonArgs(argv)
  if (!parsed) {
    return false
  }

  const layer = makeSelfContainedLayer()
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer as never))
  const daemonServicesEffect = Effect.gen(function* () {
    return {
      paths: yield* ClawctlPathsService,
      runtime: yield* ClawctlRuntimeService,
      store: yield* ClawctlStoreService,
    }
  }).pipe(Effect.provide(layer as never)) as unknown as Effect.Effect<DaemonServices, never, never>
  const { paths, runtime, store } = await Effect.runPromise(daemonServicesEffect)
  const record = (await Effect.runPromise(
    provided(store.resolveInstalledRecord(parsed.implementation, parsed.version, parsed.backend)),
  )) as InstallRecord
  await Effect.runPromise(provided(runtime.prepareRuntime(record)))

  const writeRuntimeRecord = async (input: Partial<RuntimeRecord>) => {
    const existing = await Effect.runPromise(
      provided(store.readRuntimeRecord(record.implementation, record.resolvedVersion, record.backend)),
    )
    const base = (existing ??
      ({
        implementation: record.implementation,
        version: record.resolvedVersion,
        backend: record.backend,
        runtimeRoot: paths.runtimeRoot(record.implementation, record.resolvedVersion, record.backend),
        active: true,
        managedByClawctl: true,
        proxyMode: "proxy",
        state: "starting",
        updatedAt: nowIso(),
      } satisfies RuntimeRecord)) as RuntimeRecord
    await Effect.runPromise(provided(store.writeRuntimeRecord(normalizeRuntimeRecord(base, input))))
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ state: "running" })
      }
      if (request.method === "GET" && url.pathname === "/status") {
        const runtimeRecord = await Effect.runPromise(
          provided(store.readRuntimeRecord(record.implementation, record.resolvedVersion, record.backend)),
        )
        return Response.json(runtimeRecord ?? { state: "stopped" })
      }
      if (request.method === "POST" && (url.pathname === "/chat" || url.pathname === "/ping")) {
        try {
          const body = url.pathname === "/ping" ? { message: runtime.pingText() } : await request.json()
          const output = await Effect.runPromise(provided(runtime.runChatDirect(record, String(body.message ?? ""))))
          return Response.json({ output })
        } catch (cause) {
          return Response.json(
            {
              error: cause instanceof Error ? cause.message : String(cause),
            },
            { status: 500 },
          )
        }
      }
      return new Response("not found", { status: 404 })
    },
  })

  await writeRuntimeRecord({
    active: true,
    managedByClawctl: true,
    pid: process.pid,
    proxyMode: "proxy",
    startedAt: nowIso(),
    state: "running",
    ...(server.port === undefined ? {} : { port: server.port }),
  })

  const shutdown = async () => {
    server.stop(true)
    await writeRuntimeRecord({
      active: false,
      state: "stopped",
      stoppedAt: nowIso(),
    })
    process.exit(0)
  }

  process.on("SIGTERM", () => {
    void shutdown()
  })
  process.on("SIGINT", () => {
    void shutdown()
  })

  await new Promise<void>(() => {
    // Keep the managed daemon alive until it receives a signal.
  })
  return true
}

export async function maybeRunShimmedCommand(argv: string[]): Promise<boolean> {
  const parsed = parseShimArgs(argv)
  if (!parsed) {
    return false
  }

  const layer = makeSelfContainedLayer()
  const runtimeServicesEffect = Effect.gen(function* () {
    return {
      runtime: yield* ClawctlRuntimeService,
    }
  }).pipe(Effect.provide(layer as never)) as unknown as Effect.Effect<{ runtime: ClawctlRuntimeApi }, never, never>

  try {
    const { runtime } = await Effect.runPromise(runtimeServicesEffect)
    const exitCode = await Effect.runPromise(runtime.runShimmedCommand(parsed.implementation, parsed.args))
    process.exitCode = exitCode
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(detail)
    process.exitCode = 1
  }

  return true
}

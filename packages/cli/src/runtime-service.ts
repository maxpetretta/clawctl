import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import { BunContext } from "@effect/platform-bun"
import { Context, Effect, Layer, type Option } from "effect"

import { getRegisteredImplementation } from "./adapter/registry.ts"
import type { RuntimeManifest } from "./adapter/schema.ts"
import type { InstallRecord, RegisteredImplementation, RuntimeRecord } from "./adapter/types.ts"
import { type ClawctlError, userError, withSystemError } from "./errors.ts"
import { ClawctlPathsLive, ClawctlPathsService } from "./paths-service.ts"
import { missingSharedConfigKeys, sharedConfigToEntries } from "./shared-config.ts"
import { ClawctlStoreLive, ClawctlStoreService } from "./store-service.ts"
import type { TargetReference } from "./target.ts"
import { parseTargetReference } from "./target.ts"

const daemonSentinel = "__daemon__"
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
  readonly pingText: () => string
  readonly runtimeState: (record: InstallRecord) => Effect.Effect<RuntimeSnapshot, ClawctlError>
  readonly stopSelection: (target: Option.Option<string>) => Effect.Effect<StopSelectionResult, ClawctlError>
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
    resolveInstalledRecord: (implementation: string, version?: string) => Effect.Effect<InstallRecord, ClawctlError>
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

type ResolvedRuntime = {
  readonly registration: RegisteredImplementation & {
    messagingUnavailableReason?: string
    implementationHooks: {
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
      normalizeChatOutput?: (input: { stdout: string; stderr: string }) => string
      renderConfig: (input: { config: Record<string, string>; workspaceDir: string }) => Promise<
        Array<{
          content: string
          path: string
        }>
      >
      runtimeEnv: (input: {
        config: Record<string, string>
        homeDir: string
        installRoot: string
        port?: number
        runtimeDir: string
        stateDir: string
        workspaceDir: string
      }) => NodeJS.ProcessEnv
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
    const resolveRegistration = Effect.fn("ClawctlRuntimeService.resolveRegistration")(function* (
      implementation: string,
    ) {
      return yield* Effect.try({
        try: () => getRegisteredImplementation(implementation),
        catch: (cause) =>
          userError("runtime.resolveRegistration", cause instanceof Error ? cause.message : String(cause)),
      })
    })
    const parseReference = Effect.fn("ClawctlRuntimeService.parseReference")(function* (target: string) {
      return yield* Effect.try({
        try: () => parseTargetReference(target),
        catch: (cause) =>
          userError("runtime.parseTargetReference", cause instanceof Error ? cause.message : String(cause)),
      })
    })
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
      const [command, ...fixedArgs] = record.entrypointCommand
      if (!command) {
        return yield* userError("runtime.updateActiveShims", `missing binary for ${record.implementation}`)
      }

      const wrapper = `#!/bin/sh
exec ${[command, ...fixedArgs].map(shellQuote).join(" ")} "$@"
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
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion)
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion)

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

      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion)
      const configEntries = yield* resolveSharedConfigEntries()
      return yield* Effect.tryPromise({
        try: () =>
          registration.implementationHooks.status?.({
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
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
      if (resolvedTarget) {
        const parsed = yield* parseReference(resolvedTarget)
        return yield* store.resolveInstalledRecord(parsed.implementation, parsed.version)
      }
      const current = yield* store.readCurrentSelection
      if (!current) {
        return yield* userError("runtime.resolveChatTarget", "no active claw selected")
      }
      return yield* store.resolveInstalledRecord(current.implementation, current.version)
    })

    const writeRuntimeState = Effect.fn("ClawctlRuntimeService.writeRuntimeState")(function* (
      record: InstallRecord,
      next: Partial<RuntimeRecord>,
    ) {
      const existing = yield* store.readRuntimeRecord(record.implementation, record.resolvedVersion, record.backend)
      const base = existing ?? (yield* buildRuntimeRecord(record, {}))
      yield* store.writeRuntimeRecord(normalizeRuntimeRecord(base, next))
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
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion)
      if (registration.implementationHooks.chat) {
        return yield* Effect.tryPromise({
          try: () =>
            registration.implementationHooks.chat?.({
              binaryPath: record.entrypointCommand[0] ?? "",
              config: configEntries,
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
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
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
              config: configEntries,
              homeDir,
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

      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion)
      const runtimeDir = runtimeRoot(record.implementation, record.resolvedVersion)
      const stateDir = runtimeStateDir(record.implementation, record.resolvedVersion)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion)
      const configEntries = yield* resolveSharedConfigEntries()
      const start = yield* Effect.tryPromise({
        try: () =>
          registration.implementationHooks.start?.({
            binaryPath: record.entrypointCommand[0] ?? "",
            config: configEntries,
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

    const spawnManagedRuntime = Effect.fn("ClawctlRuntimeService.spawnManagedRuntime")(function* (
      record: InstallRecord,
    ) {
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
      const record = yield* store.resolveInstalledRecord(target.implementation, target.version)
      const current = yield* store.readCurrentSelection
      const previousImplementation = current?.implementation
      if (
        current &&
        (current.implementation !== record.implementation ||
          current.version !== record.resolvedVersion ||
          current.backend !== record.backend)
      ) {
        const currentRecord = yield* store
          .resolveInstalledRecord(current.implementation, current.version)
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
      const record = yield* resolveChatTarget(target)
      const registration = yield* resolveRegistration(record.implementation)
      if (!registration.manifest.capabilities[capability]) {
        const detail = registration.messagingUnavailableReason ? ` (${registration.messagingUnavailableReason})` : ""
        return yield* userError(
          "runtime.ensureActiveChatTarget",
          `implementation does not support ${capability}: ${record.implementation}${detail}`,
        )
      }
      return yield* activateSelection({
        implementation: record.implementation,
        version: record.resolvedVersion,
      })
    })

    const requestChat = Effect.fn("ClawctlRuntimeService.requestChat")(function* (
      record: InstallRecord,
      message: string,
    ) {
      const runtimeRecord = yield* spawnManagedRuntime(record)
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

    const stopSelection = Effect.fn("ClawctlRuntimeService.stopSelection")(function* (target: Option.Option<string>) {
      const resolvedTarget = target._tag === "Some" ? target.value : undefined
      let record: InstallRecord | undefined
      const current = yield* store.readCurrentSelection
      if (resolvedTarget) {
        const parsed = yield* parseReference(resolvedTarget)
        record = yield* store.resolveInstalledRecord(parsed.implementation, parsed.version)
      } else {
        if (!current) {
          return { stopped: false } satisfies StopSelectionResult
        }
        record = yield* store.resolveInstalledRecord(current.implementation, current.version)
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

export async function maybeRunManagedDaemon(argv: string[]): Promise<boolean> {
  const parsed = parseDaemonArgs(argv)
  if (!parsed) {
    return false
  }

  const baseLayer = BunContext.layer
  const pathsLayer = ClawctlPathsLive.pipe(Layer.provide(baseLayer))
  const storeLayer = ClawctlStoreLive.pipe(Layer.provide(Layer.mergeAll(baseLayer, pathsLayer)))
  const runtimeLayer = ClawctlRuntimeLive.pipe(Layer.provide(Layer.mergeAll(baseLayer, pathsLayer, storeLayer)))
  const layer = Layer.mergeAll(baseLayer, pathsLayer, storeLayer, runtimeLayer)
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
    provided(store.resolveInstalledRecord(parsed.implementation, parsed.version)),
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

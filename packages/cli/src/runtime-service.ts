import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import { Context, Effect, Layer, type Option } from "effect"

import { getRegisteredImplementation } from "./adapter/registry.ts"
import type { InstallRecord } from "./adapter/types.ts"
import { type ClawctlError, userError, withSystemError } from "./errors.ts"
import { ClawctlPathsService } from "./paths-service.ts"
import { missingSharedConfigKeys, sharedConfigToEntries } from "./shared-config.ts"
import { ClawctlStoreService } from "./store-service.ts"
import type { TargetReference } from "./target.ts"
import { parseTargetReference } from "./target.ts"

type ClawctlRuntimeApi = {
  readonly activateSelection: (target: TargetReference) => Effect.Effect<InstallRecord, ClawctlError>
  readonly ensureActiveChatTarget: (
    target: Option.Option<string>,
    capability?: "chat" | "ping",
  ) => Effect.Effect<InstallRecord, ClawctlError>
  readonly runChat: (record: InstallRecord, message: string) => Effect.Effect<string, ClawctlError>
  readonly pingText: () => string
}

export class ClawctlRuntimeService extends Context.Tag("@clawctl/cli/ClawctlRuntimeService")<
  ClawctlRuntimeService,
  ClawctlRuntimeApi
>() {}

export const ClawctlRuntimeLive = Layer.effect(
  ClawctlRuntimeService,
  Effect.gen(function* () {
    const commandExecutor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const { path, runtimeHomeDir, runtimeRoot, runtimeStateDir, runtimeWorkspaceDir } = yield* ClawctlPathsService
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

    const renderRuntimeConfig = Effect.fn("ClawctlRuntimeService.renderRuntimeConfig")(function* (
      record: InstallRecord,
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

      for (const file of registration.manifest.config.files) {
        const missingKeys = missingSharedConfigKeys(config, file.requiredKeys)
        if (missingKeys.length > 0) {
          return yield* userError(
            "runtime.renderRuntimeConfig",
            `shared config key is missing or placeholder: ${missingKeys[0]}`,
          )
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

    const activateSelection = Effect.fn("ClawctlRuntimeService.activateSelection")(function* (target: TargetReference) {
      const record = yield* store.resolveInstalledRecord(target.implementation, target.version)
      yield* renderRuntimeConfig(record)
      yield* store.writeCurrentSelection({
        implementation: record.implementation,
        version: record.resolvedVersion,
        backend: record.backend,
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
        return yield* userError(
          "runtime.ensureActiveChatTarget",
          `implementation does not support ${capability}: ${record.implementation}`,
        )
      }
      yield* activateSelection({
        implementation: record.implementation,
        version: record.resolvedVersion,
      })
      return record
    })
    const runChat = Effect.fn("ClawctlRuntimeService.runChat")(function* (record: InstallRecord, message: string) {
      yield* store.ensureSharedConfig
      yield* renderRuntimeConfig(record)

      const registration = yield* resolveRegistration(record.implementation)
      const homeDir = runtimeHomeDir(record.implementation, record.resolvedVersion)
      const workspaceDir = runtimeWorkspaceDir(record.implementation, record.resolvedVersion)
      const commandArgs = yield* Effect.try({
        try: () =>
          registration.implementationHooks.buildChatCommand({
            binaryPath: record.entrypointCommand[0] ?? "",
            message,
          }),
        catch: (cause) => userError("runtime.buildChatCommand", cause instanceof Error ? cause.message : String(cause)),
      })
      const [file, ...args] = commandArgs
      if (!file) {
        return yield* userError("runtime.runChat", `missing binary for ${record.implementation}`)
      }
      if (file.includes("/")) {
        const exists = yield* withSystemError("runtime.binaryExists", fs.exists(file))
        if (!exists) {
          return yield* userError("runtime.runChat", `missing binary for ${record.implementation}`)
        }
      }

      const env = {
        ...process.env,
        ...(yield* Effect.try({
          try: () =>
            registration.implementationHooks.runtimeEnv({
              homeDir,
              runtimeDir: runtimeRoot(record.implementation, record.resolvedVersion),
              workspaceDir,
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

    return ClawctlRuntimeService.of({
      activateSelection,
      ensureActiveChatTarget,
      runChat,
      pingText: () => "Reply with exactly the single word pong.",
    })
  }),
)

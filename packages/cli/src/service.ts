import * as Terminal from "@effect/platform/Terminal"
import { Context, type Effect, Effect as EffectRuntime, Layer, Option } from "effect"

import { getRegisteredImplementation, listRegisteredImplementations } from "./adapter/registry.ts"
import type { InstallRecord, RegisteredImplementation } from "./adapter/types.ts"
import { validateAdapterRegistry } from "./adapter/validate.ts"
import { type ClawctlError, userError, withSystemError } from "./errors.ts"
import { ClawctlInstallerLive, ClawctlInstallerService } from "./installer-service.ts"
import { ClawctlMaintenanceLive, ClawctlMaintenanceService } from "./maintenance-service.ts"
import type { RuntimeBackend } from "./model.ts"
import { ClawctlPathsLive } from "./paths-service.ts"
import { ClawctlRuntimeLive, ClawctlRuntimeService } from "./runtime-service.ts"
import { sharedConfigValue } from "./shared-config.ts"
import { ClawctlStoreLive, ClawctlStoreService } from "./store-service.ts"
import { parseTargetReference } from "./target.ts"

type TargetSelection = {
  runtime: RuntimeBackend
  target: string
}

type MaybeTargetSelection = {
  runtime: RuntimeBackend
  target: Option.Option<string>
}

export type ClawctlApi = {
  chat: (input: { message: string; target: Option.Option<string> }) => Effect.Effect<void, ClawctlError>
  cleanup: (input: { target: Option.Option<string> }) => Effect.Effect<void, ClawctlError>
  configGet: (key: string) => Effect.Effect<void, ClawctlError>
  configSet: (input: { key: string; value: string }) => Effect.Effect<void, ClawctlError>
  current: Effect.Effect<void, ClawctlError>
  doctor: (input: { target: Option.Option<string> }) => Effect.Effect<void, ClawctlError>
  install: (input: TargetSelection) => Effect.Effect<void, ClawctlError>
  list: (input: { installedOnly: boolean }) => Effect.Effect<void, ClawctlError>
  ping: (input: { target: Option.Option<string> }) => Effect.Effect<void, ClawctlError>
  status: (input: { target: Option.Option<string> }) => Effect.Effect<void, ClawctlError>
  stop: (input: MaybeTargetSelection) => Effect.Effect<void, ClawctlError>
  uninstall: (input: TargetSelection & { all: boolean }) => Effect.Effect<void, ClawctlError>
  use: (input: TargetSelection) => Effect.Effect<void, ClawctlError>
  versions: (target: string) => Effect.Effect<void, ClawctlError>
}

export class ClawctlService extends Context.Tag("@clawctl/cli/ClawctlService")<ClawctlService, ClawctlApi>() {}

function printStatus(
  writeLine: (text: string) => Effect.Effect<void, ClawctlError>,
  record: InstallRecord,
  active: boolean,
  registration: RegisteredImplementation,
  runtimeState: {
    active: boolean
    managedByClawctl: boolean
    pid?: number
    port?: number
    state: string
  },
): Effect.Effect<void, ClawctlError> {
  const runtime = registration.manifest.backends.find((backend) => backend.kind === record.backend)?.runtime
  return EffectRuntime.gen(function* () {
    yield* writeLine(`${record.implementation}@${record.resolvedVersion}`)
    yield* writeLine(`  backend: ${record.backend}`)
    yield* writeLine("  installed: yes")
    yield* writeLine(`  active: ${active ? "yes" : "no"}`)
    yield* writeLine(`  supervision: ${runtime?.supervision.kind ?? "unknown"}`)
    yield* writeLine(`  chat: ${registration.manifest.capabilities.chat ? "yes" : "no"}`)
    yield* writeLine(`  ping: ${registration.manifest.capabilities.ping ? "yes" : "no"}`)
    yield* writeLine(`  state: ${registration.manifest.capabilities.chat ? runtimeState.state : "install-only"}`)
    if (runtimeState.pid !== undefined) {
      yield* writeLine(`  pid: ${runtimeState.pid}`)
    }
    if (runtimeState.port !== undefined) {
      yield* writeLine(`  port: ${runtimeState.port}`)
    }
  })
}

const pathsLayer = ClawctlPathsLive
const storeLayer = ClawctlStoreLive.pipe(Layer.provide(pathsLayer))
const storeDependencies = Layer.mergeAll(pathsLayer, storeLayer)
const installerLayer = ClawctlInstallerLive.pipe(Layer.provide(storeDependencies))
const maintenanceLayer = ClawctlMaintenanceLive.pipe(Layer.provide(storeDependencies))
const runtimeLayer = ClawctlRuntimeLive.pipe(Layer.provide(Layer.mergeAll(pathsLayer, storeLayer)))
const dependencyLayer = Layer.mergeAll(pathsLayer, storeLayer, installerLayer, maintenanceLayer, runtimeLayer)

const clawctlServiceLayer = Layer.effect(
  ClawctlService,
  EffectRuntime.gen(function* () {
    const terminal = yield* Terminal.Terminal
    const store = yield* ClawctlStoreService
    const installer = yield* ClawctlInstallerService
    const runtime = yield* ClawctlRuntimeService
    const maintenance = yield* ClawctlMaintenanceService
    const writeLine = (text: string) => withSystemError("service.display", terminal.display(`${text}\n`))
    const resolveRegistration = EffectRuntime.fn("ClawctlService.resolveRegistration")(function* (
      implementation: string,
    ) {
      return yield* EffectRuntime.try({
        try: () => getRegisteredImplementation(implementation),
        catch: (cause) =>
          userError("service.resolveRegistration", cause instanceof Error ? cause.message : String(cause)),
      })
    })
    const parseReference = EffectRuntime.fn("ClawctlService.parseReference")(function* (target: string) {
      return yield* EffectRuntime.try({
        try: () => parseTargetReference(target),
        catch: (cause) =>
          userError("service.parseTargetReference", cause instanceof Error ? cause.message : String(cause)),
      })
    })
    const validateRegistry = EffectRuntime.try({
      try: () => validateAdapterRegistry(),
      catch: (cause) => userError("service.validateRegistry", cause instanceof Error ? cause.message : String(cause)),
    })
    const parseOptionalImplementationTarget = EffectRuntime.fn("ClawctlService.parseOptionalImplementationTarget")(
      function* (target: Option.Option<string>) {
        if (Option.isNone(target)) {
          return undefined
        }
        const parsed = yield* parseReference(target.value)
        return parsed.implementation
      },
    )
    const activationSupported = EffectRuntime.fn("ClawctlService.activationSupported")(function* (
      implementation: string,
    ) {
      const registration = yield* resolveRegistration(implementation)
      return registration.manifest.capabilities.chat
    })
    const requireLocalRuntime = (runtime: string) =>
      runtime === "local"
        ? EffectRuntime.void
        : EffectRuntime.fail(userError("service.runtime", `runtime is not implemented yet: ${runtime}`))

    const chat = EffectRuntime.fn("ClawctlService.chat")(function* (input: {
      message: string
      target: Option.Option<string>
    }) {
      const installRecord = yield* runtime.ensureActiveChatTarget(input.target, "chat")
      const response = yield* runtime.requestChat(installRecord, input.message)
      yield* writeLine(response)
    })

    const cleanup = EffectRuntime.fn("ClawctlService.cleanup")(function* (input: { target: Option.Option<string> }) {
      const parsedReference = Option.isSome(input.target) ? yield* parseReference(input.target.value) : undefined
      if (parsedReference?.version) {
        return yield* userError("service.cleanup", "cleanup target must not include a version")
      }
      const parsedTarget = parsedReference?.implementation
      const report = yield* maintenance.runCleanup(parsedTarget)
      yield* writeLine(
        `cleanup: removed ${report.removedPartialInstalls} partial installs, ${report.removedRuntimeDirs} orphaned runtimes${report.clearedCurrent ? ", cleared stale current selection" : ""}`,
      )
    })

    const configGet = EffectRuntime.fn("ClawctlService.configGet")(function* (key: string) {
      const config = yield* store.readSharedConfig
      const value = sharedConfigValue(config, key)
      if (value === undefined) {
        return yield* userError("service.configGet", `shared config key is not set: ${key}`)
      }
      yield* writeLine(value)
    })

    const configSet = EffectRuntime.fn("ClawctlService.configSet")(function* (input: { key: string; value: string }) {
      yield* store.ensureSharedConfig
      yield* store.setSharedConfigValue(input.key, input.value)
      yield* writeLine(`set ${input.key}`)
    })

    const current = EffectRuntime.gen(function* () {
      const selection = yield* store.readCurrentSelection
      if (!selection) {
        yield* writeLine("no active claw")
        return
      }

      const stillInstalled = yield* store.resolveInstalledRecord(selection.implementation, selection.version).pipe(
        EffectRuntime.as(true),
        EffectRuntime.catchAll(() => EffectRuntime.succeed(false)),
      )
      if (!stillInstalled) {
        yield* store.clearCurrentSelection
        yield* writeLine("no active claw")
        return
      }

      yield* writeLine(`${selection.implementation}@${selection.version} (${selection.backend})`)
    }).pipe(EffectRuntime.withSpan("ClawctlService.current"))

    const doctor = EffectRuntime.fn("ClawctlService.doctor")(function* (input: { target: Option.Option<string> }) {
      yield* validateRegistry
      const parsedTarget = yield* parseOptionalImplementationTarget(input.target)
      if (parsedTarget) {
        yield* resolveRegistration(parsedTarget)
      }
      const report = yield* maintenance.runDoctor(parsedTarget)
      for (const check of report.checks) {
        yield* writeLine(`${check.ok ? "ok" : "error"}: ${check.label}: ${check.detail}`)
      }
      yield* writeLine(`doctor: ${report.ok ? "ok" : "failed"}`)
      if (!report.ok) {
        return yield* userError("service.doctor", "doctor failed")
      }
    })

    const install = EffectRuntime.fn("ClawctlService.install")(function* (input: { runtime: string; target: string }) {
      yield* requireLocalRuntime(input.runtime)
      const parsed = yield* parseReference(input.target)
      const record = yield* installer.installImplementation(parsed.implementation, parsed.version)
      yield* writeLine(`installed ${record.implementation}@${record.resolvedVersion}`)
    })

    const list = EffectRuntime.fn("ClawctlService.list")(function* (input: { installedOnly: boolean }) {
      const records = yield* store.listInstallRecords
      const currentSelection = yield* store.readCurrentSelection

      if (input.installedOnly) {
        for (const record of records) {
          const active =
            currentSelection &&
            currentSelection.implementation === record.implementation &&
            currentSelection.version === record.resolvedVersion
          yield* writeLine(`${record.implementation}@${record.resolvedVersion}${active ? " *" : ""}`)
        }
        return
      }

      for (const registration of listRegisteredImplementations()) {
        const installed = records
          .filter((record) => record.implementation === registration.manifest.id)
          .map((record) => record.resolvedVersion)
        yield* writeLine(`${registration.manifest.id} (${registration.manifest.supportTier})`)
        yield* writeLine(`  installed: ${installed.length > 0 ? installed.join(", ") : "<none>"}`)
      }
    })

    const ping = EffectRuntime.fn("ClawctlService.ping")(function* (input: { target: Option.Option<string> }) {
      const installRecord = yield* runtime.ensureActiveChatTarget(input.target, "ping")
      const response = yield* runtime.requestChat(installRecord, runtime.pingText())
      yield* writeLine(response)
    })

    const status = EffectRuntime.fn("ClawctlService.status")(function* (input: { target: Option.Option<string> }) {
      const currentSelection = yield* store.readCurrentSelection
      if (Option.isSome(input.target)) {
        const parsed = yield* parseReference(input.target.value)
        const registration = yield* resolveRegistration(parsed.implementation)
        const record = yield* store.resolveInstalledRecord(parsed.implementation, parsed.version)
        const active =
          currentSelection &&
          currentSelection.implementation === record.implementation &&
          currentSelection.version === record.resolvedVersion
        yield* printStatus(writeLine, record, Boolean(active), registration, yield* runtime.runtimeState(record))
        return
      }

      if (!currentSelection) {
        yield* writeLine("no active claw")
        return
      }

      const record = yield* store.resolveInstalledRecord(currentSelection.implementation, currentSelection.version)
      const registration = yield* resolveRegistration(record.implementation)
      yield* printStatus(writeLine, record, true, registration, yield* runtime.runtimeState(record))
    })

    const stop = EffectRuntime.fn("ClawctlService.stop")(function* (input: {
      runtime: string
      target: Option.Option<string>
    }) {
      yield* requireLocalRuntime(input.runtime)
      const result = yield* runtime.stopSelection(input.target)
      if (!result.record) {
        yield* writeLine("stop: no active claw")
        return
      }
      yield* writeLine(
        result.stopped
          ? `stopped ${result.record.implementation}@${result.record.resolvedVersion}`
          : `stop: runtime already stopped for ${result.record.implementation}@${result.record.resolvedVersion}`,
      )
    })

    const uninstall = EffectRuntime.fn("ClawctlService.uninstall")(function* (input: {
      all: boolean
      runtime: string
      target: string
    }) {
      yield* requireLocalRuntime(input.runtime)
      const parsed = yield* parseReference(input.target)
      if (input.all && parsed.version) {
        return yield* userError("service.uninstall", "uninstall --all target must not include a version")
      }

      const records = input.all
        ? (yield* store.listInstallRecords).filter((record) => record.implementation === parsed.implementation)
        : [yield* store.resolveInstalledRecord(parsed.implementation, parsed.version)]
      if (records.length === 0) {
        return yield* userError("service.uninstall", `implementation is not installed: ${parsed.implementation}`)
      }

      const currentSelection = yield* store.readCurrentSelection
      if (
        currentSelection &&
        records.some(
          (record) =>
            currentSelection.implementation === record.implementation &&
            currentSelection.version === record.resolvedVersion,
        )
      ) {
        yield* store.clearCurrentSelection
      }

      for (const record of records) {
        yield* runtime
          .stopSelection(Option.some(`${record.implementation}@${record.resolvedVersion}`))
          .pipe(EffectRuntime.catchAll(() => EffectRuntime.void))
        yield* store.removeRuntime(record.implementation, record.resolvedVersion, record.backend)
        yield* store.removeInstall(record)
      }

      yield* store.cleanupOrphanedRuntimeDirectories(parsed.implementation, "local")
      if (input.all) {
        yield* writeLine(`uninstalled ${records.length} version(s) of ${parsed.implementation}`)
        return
      }

      const [record] = records
      if (!record) {
        return yield* userError("service.uninstall", `implementation is not installed: ${parsed.implementation}`)
      }
      yield* writeLine(`uninstalled ${record.implementation}@${record.resolvedVersion}`)
    })

    const use = EffectRuntime.fn("ClawctlService.use")(function* (input: { runtime: string; target: string }) {
      yield* requireLocalRuntime(input.runtime)
      const parsed = yield* parseReference(input.target)
      if (!(yield* activationSupported(parsed.implementation))) {
        return yield* userError("service.use", `implementation cannot be activated yet: ${parsed.implementation}`)
      }

      const record = yield* store
        .resolveInstalledRecord(parsed.implementation, parsed.version)
        .pipe(EffectRuntime.catchAll(() => installer.installImplementation(parsed.implementation, parsed.version)))
      const activated = yield* runtime.activateSelection({
        implementation: record.implementation,
        version: parsed.version ?? record.resolvedVersion,
      })
      yield* writeLine(`using ${activated.implementation}@${activated.resolvedVersion}`)
    })

    const versions = EffectRuntime.fn("ClawctlService.versions")(function* (target: string) {
      const parsed = yield* parseReference(target)
      if (parsed.version) {
        return yield* userError("service.versions", "versions target must not include a version")
      }

      const versions = yield* installer.listRemoteVersions(parsed.implementation)
      for (const version of versions) {
        yield* writeLine(version)
      }
    })

    return ClawctlService.of({
      chat,
      cleanup,
      configGet,
      configSet,
      current,
      doctor,
      install,
      list,
      ping,
      status,
      stop,
      uninstall,
      use,
      versions,
    })
  }),
).pipe(Layer.provide(dependencyLayer))

export const ClawctlLive = clawctlServiceLayer

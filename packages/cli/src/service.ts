import { basename } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Terminal from "@effect/platform/Terminal"
import { Context, Effect, Fiber, Layer, Option } from "effect"

import { listRegisteredImplementations } from "./adapter/registry.ts"
import type { InstallRecord, RegisteredImplementation } from "./adapter/types.ts"
import { validateAdapterRegistry } from "./adapter/validate.ts"
import { type ClawctlError, userError, withSystemError } from "./errors.ts"
import { ClawctlInstallerService } from "./installer-service.ts"
import { fullDependencyLayer } from "./layer.ts"
import { ClawctlMaintenanceService } from "./maintenance-service.ts"
import type { RuntimeBackend } from "./model.ts"
import { ClawctlPathsService } from "./paths-service.ts"
import { ClawctlRuntimeService } from "./runtime-service.ts"
import { makeParseReference, makeRequireInteractableImplementation, makeResolveRegistration } from "./service-helpers.ts"
import { sharedConfigValue } from "./shared-config.ts"
import { ClawctlStoreService } from "./store-service.ts"

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
  init: (input: { shell: Option.Option<string> }) => Effect.Effect<void, ClawctlError>
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
  return Effect.gen(function* () {
    const runtimeStateLabel = runtime?.supervision.kind === "unmanaged" ? "install-only" : runtimeState.state
    yield* writeLine(`${record.implementation}@${record.resolvedVersion}`)
    yield* writeLine(`  backend: ${record.backend}`)
    yield* writeLine("  installed: yes")
    yield* writeLine(`  active: ${active ? "yes" : "no"}`)
    yield* writeLine(`  supervision: ${runtime?.supervision.kind ?? "unknown"}`)
    yield* writeLine(`  chat: ${registration.manifest.capabilities.chat ? "yes" : "no"}`)
    yield* writeLine(`  ping: ${registration.manifest.capabilities.ping ? "yes" : "no"}`)
    yield* writeLine(`  state: ${runtimeStateLabel}`)
    if (runtimeState.pid !== undefined) {
      yield* writeLine(`  pid: ${runtimeState.pid}`)
    }
    if (runtimeState.port !== undefined) {
      yield* writeLine(`  port: ${runtimeState.port}`)
    }
  })
}

type ShellPathHint = {
  readonly configFile: string
  readonly configFileDisplay: string
  readonly line: string
}

type SupportedShell = "bash" | "fish" | "zsh"

function detectSupportedShell(value: string | undefined): SupportedShell | undefined {
  const shellName = value ? basename(value) : ""
  switch (shellName) {
    case "bash":
    case "fish":
    case "zsh":
      return shellName
    default:
      return undefined
  }
}

function displayPathForShell(path: string, homeDir: string | undefined, shell: SupportedShell): string {
  if (homeDir && path.startsWith(`${homeDir}/`)) {
    const relative = path.slice(homeDir.length + 1)
    if (shell === "fish") {
      return `~/${relative}`
    }
    return `$HOME/${relative}`
  }
  return path
}

function displayConfigPath(path: string, homeDir: string | undefined): string {
  if (homeDir && path.startsWith(`${homeDir}/`)) {
    const relative = path.slice(homeDir.length + 1)
    return `~/${relative}`
  }
  return path
}

function pathEntriesFromEnv(pathValue: string | undefined): string[] {
  return (pathValue ?? "").split(":").filter((entry) => entry.length > 0)
}

function shellPathHint(shell: SupportedShell, binDir: string, homeDir: string | undefined): ShellPathHint {
  const binPathDisplay = displayPathForShell(binDir, homeDir, shell)
  switch (shell) {
    case "fish": {
      const configFile = homeDir ? `${homeDir}/.config/fish/config.fish` : "~/.config/fish/config.fish"
      return {
        configFile,
        configFileDisplay: displayConfigPath(configFile, homeDir),
        line: `fish_add_path -U ${binPathDisplay}`,
      }
    }
    case "bash": {
      const configFile = homeDir ? `${homeDir}/.bashrc` : "~/.bashrc"
      return {
        configFile,
        configFileDisplay: displayConfigPath(configFile, homeDir),
        line: `export PATH="${binPathDisplay}:$PATH"`,
      }
    }
    case "zsh": {
      const configFile = homeDir ? `${homeDir}/.zshrc` : "~/.zshrc"
      return {
        configFile,
        configFileDisplay: displayConfigPath(configFile, homeDir),
        line: `export PATH="${binPathDisplay}:$PATH"`,
      }
    }
  }
}

function clearLine(text: string): string {
  return `\r${" ".repeat(text.length)}\r`
}

const clawctlServiceLayer = Layer.effect(
  ClawctlService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const terminal = yield* Terminal.Terminal
    const paths = yield* ClawctlPathsService
    const store = yield* ClawctlStoreService
    const installer = yield* ClawctlInstallerService
    const runtime = yield* ClawctlRuntimeService
    const maintenance = yield* ClawctlMaintenanceService
    const writeLine = (text: string) => withSystemError("service.display", terminal.display(`${text}\n`))
    const resolveRegistration = makeResolveRegistration("ClawctlService")
    const parseReference = makeParseReference("ClawctlService")
    const requireInteractableImplementation = makeRequireInteractableImplementation(
      "ClawctlService",
      resolveRegistration,
    )
    const validateRegistry = Effect.try({
      try: () => validateAdapterRegistry(),
      catch: (cause) => userError("service.validateRegistry", cause instanceof Error ? cause.message : String(cause)),
    })
    const parseOptionalImplementationTarget = Effect.fn("ClawctlService.parseOptionalImplementationTarget")(
      function* (target: Option.Option<string>) {
        if (Option.isNone(target)) {
          return undefined
        }
        const parsed = yield* parseReference(target.value)
        return parsed.implementation
      },
    )
    const activationSupported = Effect.fn("ClawctlService.activationSupported")(function* (
      implementation: string,
    ) {
      const registration = yield* resolveRegistration(implementation)
      const localBackend = registration.manifest.backends.find(
        (backend) => backend.kind === "local" && backend.supported,
      )
      return localBackend?.runtime.supervision.kind !== "unmanaged"
    })
    const requireLocalRuntime = (runtime: string) =>
      runtime === "local"
        ? Effect.void
        : Effect.fail(userError("service.runtime", `runtime is not implemented yet: ${runtime}`))
    const pathEntries = pathEntriesFromEnv(process.env.PATH)
    const activeShimDirOnPath = pathEntries.includes(paths.paths.binDir)
    const homeDir = process.env.HOME
    const resolveShellHint = Effect.fn("ClawctlService.resolveShellHint")(function* (
      shellOverride: Option.Option<string>,
    ) {
      const detected = Option.match(shellOverride, {
        onNone: () => detectSupportedShell(process.env.SHELL),
        onSome: (value) => detectSupportedShell(value),
      })
      if (!detected) {
        return yield* userError("service.init", "unsupported shell; use one of: bash, zsh, fish")
      }
      return shellPathHint(detected, paths.paths.binDir, homeDir)
    })
    const resolvePathCommand = Effect.fn("ClawctlService.resolvePathCommand")(function* (commandName: string) {
      for (const entry of pathEntries) {
        const candidate = paths.path.resolve(entry, commandName)
        const exists = yield* withSystemError("service.resolvePathCommand", fs.exists(candidate))
        if (exists) {
          return candidate
        }
      }
      return undefined
    })
    const withInstallSpinner = <A>(effect: Effect.Effect<A, ClawctlError>): Effect.Effect<A, ClawctlError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const label = "installing"
          const interactive = yield* withSystemError("service.spinnerTty", terminal.isTTY)
          if (!interactive) {
            yield* writeLine(`${label}...`)
            return yield* effect
          }
          const frames = ["", ".", "..", "..."] as const
          const spinner = yield* Effect.forkScoped(
            Effect.forever(
              Effect.forEach(
                frames,
                (frame) =>
                  withSystemError("service.spinnerDisplay", terminal.display(`\r${label}${frame}   `)).pipe(
                    Effect.zipRight(Effect.sleep("120 millis")),
                  ),
                { discard: true },
              ),
            ),
          )
          return yield* effect.pipe(
            Effect.ensuring(
              Effect.zipRight(
                Fiber.interrupt(spinner),
                withSystemError("service.spinnerClear", terminal.display(`${clearLine(`${label}...   `)}`)).pipe(
                  Effect.catchAll(() => Effect.void),
                ),
              ),
            ),
          )
        }),
      )

    const chat = Effect.fn("ClawctlService.chat")(function* (input: {
      message: string
      target: Option.Option<string>
    }) {
      const installRecord = yield* runtime.ensureActiveChatTarget(input.target, "chat")
      const response = yield* runtime.requestChat(installRecord, input.message)
      yield* writeLine(response)
    })

    const cleanup = Effect.fn("ClawctlService.cleanup")(function* (input: { target: Option.Option<string> }) {
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

    const configGet = Effect.fn("ClawctlService.configGet")(function* (key: string) {
      const config = yield* store.readSharedConfig
      const value = sharedConfigValue(config, key)
      if (value === undefined) {
        return yield* userError("service.configGet", `shared config key is not set: ${key}`)
      }
      yield* writeLine(value)
    })

    const configSet = Effect.fn("ClawctlService.configSet")(function* (input: { key: string; value: string }) {
      yield* store.ensureSharedConfig
      yield* store.setSharedConfigValue(input.key, input.value)
      yield* writeLine(`set ${input.key}`)
    })

    const current = Effect.gen(function* () {
      const selection = yield* store.readCurrentSelection
      if (!selection) {
        yield* writeLine("no active claw")
        return
      }

      const stillInstalled = yield* store.resolveInstalledRecord(selection.implementation, selection.version).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      )
      if (!stillInstalled) {
        yield* store.clearCurrentSelection
        yield* writeLine("no active claw")
        return
      }

      yield* writeLine(`${selection.implementation}@${selection.version} (${selection.backend})`)
    }).pipe(Effect.withSpan("ClawctlService.current"))

    const doctor = Effect.fn("ClawctlService.doctor")(function* (input: { target: Option.Option<string> }) {
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

    const install = Effect.fn("ClawctlService.install")(function* (input: { runtime: string; target: string }) {
      yield* requireLocalRuntime(input.runtime)
      const parsed = yield* parseReference(input.target)
      const record = yield* withInstallSpinner(installer.installImplementation(parsed.implementation, parsed.version))
      yield* writeLine(`installed ${record.implementation}@${record.resolvedVersion}`)
    })

    const init = Effect.fn("ClawctlService.init")(function* (input: { shell: Option.Option<string> }) {
      const hint = yield* resolveShellHint(input.shell)
      const parentDir = paths.path.dirname(hint.configFile)
      yield* withSystemError("service.initMakeDir", fs.makeDirectory(parentDir, { recursive: true }))
      const exists = yield* withSystemError("service.initExists", fs.exists(hint.configFile))
      const source = exists ? yield* withSystemError("service.initReadConfig", fs.readFileString(hint.configFile)) : ""
      if (source.includes(hint.line)) {
        yield* writeLine(`init: already configured in ${hint.configFileDisplay}`)
        return
      }
      const prefix = source.length === 0 || source.endsWith("\n") ? source : `${source}\n`
      yield* withSystemError("service.initWriteConfig", fs.writeFileString(hint.configFile, `${prefix}${hint.line}\n`))
      yield* writeLine(`init: wrote PATH setup to ${hint.configFileDisplay}`)
      yield* writeLine(hint.line)
    })

    const list = Effect.fn("ClawctlService.list")(function* (input: { installedOnly: boolean }) {
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
        yield* writeLine(
          `${registration.manifest.id}: ${installed.length > 0 ? installed.join(", ") : "not installed"}`,
        )
      }
    })

    const ping = Effect.fn("ClawctlService.ping")(function* (input: { target: Option.Option<string> }) {
      const installRecord = yield* runtime.ensureActiveChatTarget(input.target, "ping")
      const response = yield* runtime.requestChat(installRecord, runtime.pingText())
      yield* writeLine(response)
    })

    const status = Effect.fn("ClawctlService.status")(function* (input: { target: Option.Option<string> }) {
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

    const stop = Effect.fn("ClawctlService.stop")(function* (input: {
      runtime: string
      target: Option.Option<string>
    }) {
      yield* requireLocalRuntime(input.runtime)
      if (Option.isSome(input.target)) {
        const parsed = yield* parseReference(input.target.value)
        yield* requireInteractableImplementation(parsed.implementation, "stop")
      } else {
        const currentSelection = yield* store.readCurrentSelection
        if (currentSelection) {
          yield* requireInteractableImplementation(currentSelection.implementation, "stop")
        }
      }
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

    const uninstall = Effect.fn("ClawctlService.uninstall")(function* (input: {
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
          .pipe(Effect.catchAll(() => Effect.void))
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

    const use = Effect.fn("ClawctlService.use")(function* (input: { runtime: string; target: string }) {
      yield* requireLocalRuntime(input.runtime)
      const parsed = yield* parseReference(input.target)
      yield* requireInteractableImplementation(parsed.implementation, "use")
      if (!(yield* activationSupported(parsed.implementation))) {
        return yield* userError("service.use", `implementation cannot be activated yet: ${parsed.implementation}`)
      }

      const record = yield* store
        .resolveInstalledRecord(parsed.implementation, parsed.version)
        .pipe(Effect.catchAll(() => installer.installImplementation(parsed.implementation, parsed.version)))
      const activated = yield* runtime.activateSelection({
        implementation: record.implementation,
        version: parsed.version ?? record.resolvedVersion,
      })
      yield* writeLine(`using ${activated.implementation}@${activated.resolvedVersion}`)
      if (!activeShimDirOnPath) {
        const detectedShell = detectSupportedShell(process.env.SHELL)
        yield* writeLine(`path hint: ${paths.paths.binDir} is not on PATH`)
        if (detectedShell) {
          const hint = shellPathHint(detectedShell, paths.paths.binDir, homeDir)
          yield* writeLine(`add this to ${hint.configFileDisplay}:`)
          yield* writeLine(hint.line)
        } else {
          yield* writeLine("add this to your shell config:")
          yield* writeLine(`export PATH="${paths.paths.binDir}:$PATH"`)
        }
        yield* writeLine("or run: clawctl init")
        return
      }

      const activeImplementationShim = paths.implementationShim(activated.implementation)
      const resolvedCommand = yield* resolvePathCommand(activated.implementation)
      if (resolvedCommand && resolvedCommand !== activeImplementationShim) {
        yield* writeLine(`path warning: ${activated.implementation} resolves to ${resolvedCommand}`)
        yield* writeLine(`move ${paths.paths.binDir} earlier on PATH so ${activated.implementation} uses ${activeImplementationShim}`)
        const detectedShell = detectSupportedShell(process.env.SHELL)
        if (detectedShell) {
          const hint = shellPathHint(detectedShell, paths.paths.binDir, homeDir)
          yield* writeLine(`ensure this appears before other PATH setup in ${hint.configFileDisplay}:`)
          yield* writeLine(hint.line)
        }
      }
    })

    const versions = Effect.fn("ClawctlService.versions")(function* (target: string) {
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
      init,
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
).pipe(Layer.provide(fullDependencyLayer))

export const ClawctlLive = clawctlServiceLayer

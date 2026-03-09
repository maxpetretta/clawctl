import { Effect, Option } from "effect"

import { getBackendManifest, getRegisteredImplementation, listRegisteredImplementations } from "./adapter/registry.ts"
import type { InstallRecord } from "./adapter/types.ts"
import { validateAdapterRegistry } from "./adapter/validate.ts"
import { installImplementation } from "./install.ts"
import { runCleanup, runDoctor } from "./maintenance.ts"
import { resolvePaths } from "./paths.ts"
import { activateSelection, ensureActiveChatTarget, pingText, runChat } from "./runtime.ts"
import { ensureSharedConfig, readSharedConfig, setSharedConfigValue } from "./shared-config.ts"
import {
  cleanupOrphanedRuntimeDirectories,
  clearCurrentSelection,
  listInstallRecords,
  readCurrentSelection,
  removeInstall,
  removeRuntime,
  resolveInstalledRecord,
} from "./state.ts"
import { parseTargetReference } from "./target.ts"

const paths = resolvePaths()

function activationSupported(implementationId: string): boolean {
  const registration = getRegisteredImplementation(implementationId)
  return registration.manifest.capabilities.chat || registration.manifest.capabilities.daemon
}

function formatRuntimeMode(implementationId: string, backend: string): string {
  const runtime = getBackendManifest(implementationId, backend === "docker" ? "docker" : "local")?.runtime
  return runtime?.mode ?? "unknown"
}

function printStatus(record: InstallRecord, active: boolean): void {
  const registration = getRegisteredImplementation(record.implementation)
  console.log(`${record.implementation}@${record.resolvedVersion}`)
  console.log(`  backend: ${record.backend}`)
  console.log("  installed: yes")
  console.log(`  active: ${active ? "yes" : "no"}`)
  console.log(`  mode: ${formatRuntimeMode(record.implementation, record.backend)}`)
  console.log(`  chat: ${registration.manifest.capabilities.chat ? "yes" : "no"}`)
  console.log(`  ping: ${registration.manifest.capabilities.ping ? "yes" : "no"}`)
  console.log(`  state: ${registration.manifest.capabilities.chat ? "idle" : "install-only"}`)
}

export const operations = {
  chat: ({ message, target }: { message: string; target: Option.Option<string> }) =>
    Effect.tryPromise(async () => {
      const installRecord = await ensureActiveChatTarget(paths, target, "chat")
      const response = await runChat(paths, installRecord, message)
      console.log(response)
    }),
  cleanup: ({ target }: { target: Option.Option<string> }) =>
    Effect.tryPromise(async () => {
      const parsedTarget = Option.match(target, {
        onNone: () => undefined,
        onSome: (value) => {
          const parsed = parseTargetReference(value)
          if (parsed.version) {
            throw new Error("cleanup target must not include a version")
          }
          return parsed.implementation
        },
      })
      const report = await runCleanup(paths, parsedTarget)
      console.log(
        `cleanup: removed ${report.removedPartialInstalls} partial installs, ${report.removedRuntimeDirs} orphaned runtimes${report.clearedCurrent ? ", cleared stale current selection" : ""}`,
      )
    }),
  configGet: (key: string) =>
    Effect.tryPromise(async () => {
      const config = await readSharedConfig(paths)
      const value = config[key]
      if (value === undefined) {
        throw new Error(`shared config key is not set: ${key}`)
      }
      console.log(value)
    }),
  configSet: ({ key, value }: { key: string; value: string }) =>
    Effect.tryPromise(async () => {
      await ensureSharedConfig(paths)
      await setSharedConfigValue(paths, key, value)
      console.log(`set ${key}`)
    }),
  current: Effect.tryPromise(async () => {
    const current = await readCurrentSelection(paths)
    if (!current) {
      console.log("no active claw")
      return
    }
    try {
      await resolveInstalledRecord(paths, current.implementation, current.version)
    } catch {
      await clearCurrentSelection(paths)
      console.log("no active claw")
      return
    }
    console.log(`${current.implementation}@${current.version} (${current.backend})`)
  }),
  doctor: ({ target }: { target: Option.Option<string> }) =>
    Effect.tryPromise(async () => {
      validateAdapterRegistry()
      const parsedTarget = Option.match(target, {
        onNone: () => undefined,
        onSome: (value) => parseTargetReference(value).implementation,
      })
      if (Option.isSome(target)) {
        getRegisteredImplementation(parsedTarget ?? "")
      }
      const report = await runDoctor(paths, parsedTarget)
      for (const check of report.checks) {
        console.log(`${check.ok ? "ok" : "error"}: ${check.label}: ${check.detail}`)
      }
      console.log(`doctor: ${report.ok ? "ok" : "failed"}`)
      if (!report.ok) {
        throw new Error("doctor failed")
      }
    }),
  install: ({ runtime, target }: { runtime: string; target: string }) =>
    Effect.tryPromise(async () => {
      if (runtime !== "local") {
        throw new Error(`runtime is not implemented yet: ${runtime}`)
      }
      const parsed = parseTargetReference(target)
      const record = await installImplementation(paths, parsed.implementation, parsed.version)
      console.log(`installed ${record.implementation}@${record.resolvedVersion}`)
    }),
  list: ({ installedOnly }: { installedOnly: boolean }) =>
    Effect.tryPromise(async () => {
      const records = await listInstallRecords(paths)
      const current = await readCurrentSelection(paths)

      if (installedOnly) {
        for (const record of records) {
          const active =
            current && current.implementation === record.implementation && current.version === record.resolvedVersion
          console.log(`${record.implementation}@${record.resolvedVersion}${active ? " *" : ""}`)
        }
        return
      }

      for (const registration of listRegisteredImplementations()) {
        const installed = records
          .filter((record) => record.implementation === registration.manifest.id)
          .map((record) => record.resolvedVersion)
        console.log(`${registration.manifest.id} (${registration.manifest.supportTier})`)
        console.log(`  installed: ${installed.length > 0 ? installed.join(", ") : "<none>"}`)
      }
    }),
  ping: ({ target }: { target: Option.Option<string> }) =>
    Effect.tryPromise(async () => {
      const installRecord = await ensureActiveChatTarget(paths, target, "ping")
      const response = await runChat(paths, installRecord, pingText())
      console.log(response)
    }),
  status: ({ target }: { target: Option.Option<string> }) =>
    Effect.tryPromise(async () => {
      const current = await readCurrentSelection(paths)
      if (Option.isSome(target)) {
        const parsed = parseTargetReference(target.value)
        const record = await resolveInstalledRecord(paths, parsed.implementation, parsed.version)
        const active =
          current && current.implementation === record.implementation && current.version === record.resolvedVersion
        printStatus(record, Boolean(active))
        return
      }

      if (!current) {
        console.log("no active claw")
        return
      }

      const record = await resolveInstalledRecord(paths, current.implementation, current.version)
      printStatus(record, true)
    }),
  stop: ({ runtime, target }: { runtime: string; target: Option.Option<string> }) =>
    Effect.sync(() => {
      if (runtime !== "local") {
        throw new Error(`runtime is not implemented yet: ${runtime}`)
      }
      const reference = Option.match(target, {
        onNone: () => "active claw",
        onSome: (value) => value,
      })
      console.log(`stop: no resident runtime for ${reference}`)
    }),
  uninstall: ({ all, runtime, target }: { all: boolean; runtime: string; target: string }) =>
    Effect.tryPromise(async () => {
      if (runtime !== "local") {
        throw new Error(`runtime is not implemented yet: ${runtime}`)
      }
      const parsed = parseTargetReference(target)
      if (all && parsed.version) {
        throw new Error("uninstall --all target must not include a version")
      }

      const records = all
        ? (await listInstallRecords(paths)).filter((record) => record.implementation === parsed.implementation)
        : [await resolveInstalledRecord(paths, parsed.implementation, parsed.version)]
      if (records.length === 0) {
        throw new Error(`implementation is not installed: ${parsed.implementation}`)
      }

      const current = await readCurrentSelection(paths)
      if (
        current &&
        records.some(
          (record) => current.implementation === record.implementation && current.version === record.resolvedVersion,
        )
      ) {
        await clearCurrentSelection(paths)
      }

      for (const record of records) {
        await removeRuntime(paths, record.implementation, record.resolvedVersion, record.backend)
        await removeInstall(paths, record)
      }

      await cleanupOrphanedRuntimeDirectories(paths, parsed.implementation, "local")
      if (all) {
        console.log(`uninstalled ${records.length} version(s) of ${parsed.implementation}`)
        return
      }
      const [record] = records
      if (!record) {
        throw new Error(`implementation is not installed: ${parsed.implementation}`)
      }
      console.log(`uninstalled ${record.implementation}@${record.resolvedVersion}`)
    }),
  use: ({ runtime, target }: { runtime: string; target: string }) =>
    Effect.tryPromise(async () => {
      if (runtime !== "local") {
        throw new Error(`runtime is not implemented yet: ${runtime}`)
      }
      const parsed = parseTargetReference(target)
      if (!activationSupported(parsed.implementation)) {
        throw new Error(`implementation cannot be activated yet: ${parsed.implementation}`)
      }
      let record: InstallRecord
      try {
        record = await resolveInstalledRecord(paths, parsed.implementation, parsed.version)
      } catch {
        record = await installImplementation(paths, parsed.implementation, parsed.version)
      }
      const activated = await activateSelection(paths, {
        implementation: record.implementation,
        version: parsed.version ?? record.resolvedVersion,
      })
      console.log(`using ${activated.implementation}@${activated.resolvedVersion}`)
    }),
}

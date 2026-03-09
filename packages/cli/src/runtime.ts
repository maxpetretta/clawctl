import { execFile } from "node:child_process"
import { access, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"

import { Option } from "effect"

import { getRegisteredImplementation } from "./adapter/registry.ts"
import type { InstallRecord } from "./adapter/types.ts"
import type { ClawctlPaths } from "./paths.ts"
import { runtimeHomeDir, runtimeRoot, runtimeWorkspaceDir } from "./paths.ts"
import type { SharedConfig } from "./shared-config.ts"
import { ensureSharedConfig, readSharedConfig } from "./shared-config.ts"
import { ensureRuntimeLayout, readCurrentSelection, resolveInstalledRecord, writeCurrentSelection } from "./state.ts"
import { parseTargetReference, type TargetReference } from "./target.ts"

const execFileAsync = promisify(execFile)

function requireConfigKeys(config: SharedConfig, requiredKeys: string[]): void {
  for (const key of requiredKeys) {
    const value = config[key]?.trim()
    if (!value || value === "replace-me") {
      throw new Error(`shared config key is missing or placeholder: ${key}`)
    }
  }
}

async function renderRuntimeConfig(
  paths: ClawctlPaths,
  installRecord: InstallRecord,
  config: SharedConfig,
): Promise<void> {
  const registration = getRegisteredImplementation(installRecord.implementation)
  const runtimeDir = runtimeRoot(paths, installRecord.implementation, installRecord.resolvedVersion)
  const homeDir = runtimeHomeDir(paths, installRecord.implementation, installRecord.resolvedVersion)
  const workspaceDir = runtimeWorkspaceDir(paths, installRecord.implementation, installRecord.resolvedVersion)
  await ensureRuntimeLayout(paths, installRecord.implementation, installRecord.resolvedVersion)

  for (const file of registration.manifest.config.files) {
    requireConfigKeys(config, file.requiredKeys)
  }

  const renderedFiles = await registration.implementationHooks.renderConfig({
    config,
    workspaceDir,
  })

  await Promise.all(
    renderedFiles.map(async (file) => {
      const destination = resolve(homeDir, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.content, "utf8")
    }),
  )

  await mkdir(runtimeDir, { recursive: true })
}

export async function activateSelection(paths: ClawctlPaths, target: TargetReference): Promise<InstallRecord> {
  const installRecord = await resolveInstalledRecord(paths, target.implementation, target.version)
  const config = await readSharedConfig(paths)
  await renderRuntimeConfig(paths, installRecord, config)
  await writeCurrentSelection(paths, {
    implementation: installRecord.implementation,
    version: installRecord.resolvedVersion,
    backend: installRecord.backend,
  })
  return installRecord
}

export async function resolveChatTarget(paths: ClawctlPaths, target: Option.Option<string>): Promise<InstallRecord> {
  const resolvedTarget = Option.match(target, {
    onNone: () => undefined,
    onSome: (value) => value,
  })

  if (resolvedTarget) {
    const parsed = parseTargetReference(resolvedTarget)
    return resolveInstalledRecord(paths, parsed.implementation, parsed.version)
  }

  const current = await readCurrentSelection(paths)
  if (!current) {
    throw new Error("no active claw selected")
  }

  return resolveInstalledRecord(paths, current.implementation, current.version)
}

export async function runChat(paths: ClawctlPaths, installRecord: InstallRecord, message: string): Promise<string> {
  await ensureSharedConfig(paths)
  const config = await readSharedConfig(paths)
  await renderRuntimeConfig(paths, installRecord, config)

  const registration = getRegisteredImplementation(installRecord.implementation)
  const homeDir = runtimeHomeDir(paths, installRecord.implementation, installRecord.resolvedVersion)
  const workspaceDir = runtimeWorkspaceDir(paths, installRecord.implementation, installRecord.resolvedVersion)
  const command = registration.implementationHooks.buildChatCommand({
    binaryPath: installRecord.entrypointCommand[0] ?? "",
    message,
  })
  const env = {
    ...process.env,
    ...registration.implementationHooks.runtimeEnv({
      homeDir,
      runtimeDir: runtimeRoot(paths, installRecord.implementation, installRecord.resolvedVersion),
      workspaceDir,
    }),
  }
  const [file, ...args] = command
  if (!file) {
    throw new Error(`missing binary for ${installRecord.implementation}`)
  }
  if (file.includes("/")) {
    try {
      await access(file)
    } catch {
      throw new Error(`missing binary for ${installRecord.implementation}`)
    }
  }

  const result = await execFileAsync(file, args, {
    cwd: workspaceDir,
    env,
    maxBuffer: 10 * 1024 * 1024,
  })
  const normalized = registration.implementationHooks.normalizeChatOutput?.({
    stdout: result.stdout,
    stderr: result.stderr,
  })
  return normalized?.trim() ?? result.stdout.trim()
}

export async function ensureActiveChatTarget(
  paths: ClawctlPaths,
  target: Option.Option<string>,
  capability: "chat" | "ping" = "chat",
): Promise<InstallRecord> {
  const installRecord = await resolveChatTarget(paths, target)
  const registration = getRegisteredImplementation(installRecord.implementation)
  if (!registration.manifest.capabilities[capability]) {
    throw new Error(`implementation does not support ${capability}: ${installRecord.implementation}`)
  }
  await activateSelection(paths, {
    implementation: installRecord.implementation,
    version: installRecord.resolvedVersion,
  })
  return installRecord
}

export function pingText(): string {
  return "Reply with exactly the single word pong."
}

import { access, readFile, writeFile } from "node:fs/promises"

import type { ClawctlPaths } from "./paths.ts"
import { ensureBaseLayout } from "./paths.ts"

export const defaultSharedConfig = {
  CLAW_API_KEY: "replace-me",
  CLAW_BASE_URL: "https://openrouter.ai/api/v1",
  CLAW_MODEL: "moonshotai/kimi-k2.5",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_BOT_USERNAME: "",
} as const

export type SharedConfig = Record<string, string>

export async function ensureSharedConfig(paths: ClawctlPaths): Promise<void> {
  await ensureBaseLayout(paths)
  try {
    await access(paths.sharedConfigFile)
  } catch {
    const lines = Object.entries(defaultSharedConfig).map(([key, value]) => `${key}=${value}`)
    await writeFile(paths.sharedConfigFile, `${lines.join("\n")}\n`, "utf8")
  }
}

export async function readSharedConfig(paths: ClawctlPaths): Promise<SharedConfig> {
  await ensureSharedConfig(paths)
  const source = await readFile(paths.sharedConfigFile, "utf8")
  const parsed: SharedConfig = {}

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    parsed[key] = value
  }

  return parsed
}

export async function setSharedConfigValue(paths: ClawctlPaths, key: string, value: string): Promise<void> {
  const next = await readSharedConfig(paths)
  next[key] = value
  const lines = Object.entries(next)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entryKey, entryValue]) => `${entryKey}=${entryValue}`)
  await writeFile(paths.sharedConfigFile, `${lines.join("\n")}\n`, "utf8")
}

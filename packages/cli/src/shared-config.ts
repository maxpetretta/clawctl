import { Config, ConfigProvider, Effect, Redacted } from "effect"
import type { ConfigError } from "effect/ConfigError"

export const defaultSharedConfig = {
  CLAW_API_KEY: "replace-me",
  CLAW_BASE_URL: "https://openrouter.ai/api/v1",
  CLAW_MODEL: "moonshotai/kimi-k2.5",
  CLAW_RUNTIME: "local",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_BOT_USERNAME: "",
  TELEGRAM_CHAT_ID: "",
  TELEGRAM_ALLOWED_FROM: "",
} as const

export type SharedConfigKey = keyof typeof defaultSharedConfig

export const sharedConfigSpec = Config.all({
  CLAW_API_KEY: Config.redacted("CLAW_API_KEY"),
  CLAW_BASE_URL: Config.string("CLAW_BASE_URL").pipe(Config.withDefault(defaultSharedConfig.CLAW_BASE_URL)),
  CLAW_MODEL: Config.string("CLAW_MODEL").pipe(Config.withDefault(defaultSharedConfig.CLAW_MODEL)),
  CLAW_RUNTIME: Config.string("CLAW_RUNTIME").pipe(Config.withDefault(defaultSharedConfig.CLAW_RUNTIME)),
  TELEGRAM_BOT_TOKEN: Config.redacted("TELEGRAM_BOT_TOKEN").pipe(
    Config.withDefault(Redacted.make(defaultSharedConfig.TELEGRAM_BOT_TOKEN)),
  ),
  TELEGRAM_BOT_USERNAME: Config.string("TELEGRAM_BOT_USERNAME").pipe(
    Config.withDefault(defaultSharedConfig.TELEGRAM_BOT_USERNAME),
  ),
  TELEGRAM_CHAT_ID: Config.string("TELEGRAM_CHAT_ID").pipe(Config.withDefault(defaultSharedConfig.TELEGRAM_CHAT_ID)),
  TELEGRAM_ALLOWED_FROM: Config.string("TELEGRAM_ALLOWED_FROM").pipe(
    Config.withDefault(defaultSharedConfig.TELEGRAM_ALLOWED_FROM),
  ),
})

export type SharedConfig = Config.Config.Success<typeof sharedConfigSpec>
export type SharedConfigEntries = Record<string, string>

export function parseSharedConfigEntries(source: string): SharedConfigEntries {
  const parsed: SharedConfigEntries = {}

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

export function stringifySharedConfigEntries(entries: SharedConfigEntries): string {
  return `${Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`
}

export function loadSharedConfig(entries: SharedConfigEntries): Effect.Effect<SharedConfig, ConfigError> {
  const provider = ConfigProvider.fromMap(new Map(Object.entries(entries)))
  return Effect.withConfigProvider(sharedConfigSpec, provider)
}

export function sharedConfigToEntries(config: SharedConfig): SharedConfigEntries {
  return {
    CLAW_API_KEY: Redacted.value(config.CLAW_API_KEY),
    CLAW_BASE_URL: config.CLAW_BASE_URL,
    CLAW_MODEL: config.CLAW_MODEL,
    CLAW_RUNTIME: config.CLAW_RUNTIME,
    TELEGRAM_BOT_TOKEN: Redacted.value(config.TELEGRAM_BOT_TOKEN),
    TELEGRAM_BOT_USERNAME: config.TELEGRAM_BOT_USERNAME,
    TELEGRAM_CHAT_ID: config.TELEGRAM_CHAT_ID,
    TELEGRAM_ALLOWED_FROM: config.TELEGRAM_ALLOWED_FROM,
  }
}

export function sharedConfigValue(config: SharedConfig, key: string): string | undefined {
  return sharedConfigToEntries(config)[key]
}

export function missingSharedConfigKeys(config: SharedConfig, keys: ReadonlyArray<string>): string[] {
  const entries = sharedConfigToEntries(config)
  return keys.filter((key) => {
    const value = entries[key]?.trim()
    return !value || value === "replace-me"
  })
}

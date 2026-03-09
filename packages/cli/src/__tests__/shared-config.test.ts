import { describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"

import {
  defaultSharedConfig,
  loadSharedConfig,
  missingSharedConfigKeys,
  parseSharedConfigEntries,
  sharedConfigToEntries,
  stringifySharedConfigEntries,
} from "../shared-config.ts"

describe("shared config", () => {
  test("loads the default shared config entries", async () => {
    const config = await Effect.runPromise(loadSharedConfig({ ...defaultSharedConfig }))
    expect(sharedConfigToEntries(config)).toEqual(defaultSharedConfig)
  })

  test("stringifies and parses env entries", () => {
    const source = stringifySharedConfigEntries({
      CLAW_API_KEY: "secret",
      CLAW_BASE_URL: defaultSharedConfig.CLAW_BASE_URL,
      CLAW_MODEL: defaultSharedConfig.CLAW_MODEL,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_BOT_USERNAME: "clawctl_bot",
    })

    expect(parseSharedConfigEntries(source)).toEqual({
      CLAW_API_KEY: "secret",
      CLAW_BASE_URL: defaultSharedConfig.CLAW_BASE_URL,
      CLAW_MODEL: defaultSharedConfig.CLAW_MODEL,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_BOT_USERNAME: "clawctl_bot",
    })
  })

  test("ignores comments and malformed env lines", async () => {
    const config = await Effect.runPromise(
      loadSharedConfig(
        parseSharedConfigEntries("# comment\nCLAW_API_KEY=secret\nINVALID\n TELEGRAM_BOT_TOKEN = token \n"),
      ),
    )

    expect(sharedConfigToEntries(config)).toEqual({
      CLAW_API_KEY: "secret",
      CLAW_BASE_URL: defaultSharedConfig.CLAW_BASE_URL,
      CLAW_MODEL: defaultSharedConfig.CLAW_MODEL,
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_BOT_USERNAME: defaultSharedConfig.TELEGRAM_BOT_USERNAME,
    })
  })

  test("detects placeholder and missing shared keys", () => {
    expect(
      missingSharedConfigKeys(
        {
          CLAW_API_KEY: Redacted.make("replace-me"),
          CLAW_BASE_URL: defaultSharedConfig.CLAW_BASE_URL,
          CLAW_MODEL: "ok",
          TELEGRAM_BOT_TOKEN: Redacted.make(""),
          TELEGRAM_BOT_USERNAME: "",
        },
        ["CLAW_API_KEY", "CLAW_MODEL", "TELEGRAM_BOT_TOKEN"],
      ),
    ).toEqual(["CLAW_API_KEY", "TELEGRAM_BOT_TOKEN"])
  })
})

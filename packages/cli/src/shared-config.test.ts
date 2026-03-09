import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolvePaths } from "./paths.ts"
import { defaultSharedConfig, ensureSharedConfig, readSharedConfig, setSharedConfigValue } from "./shared-config.ts"

const tempRoots: string[] = []

async function createPaths() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-config-"))
  tempRoots.push(root)
  return resolvePaths(root)
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("shared config", () => {
  test("writes the default shared config on first use", async () => {
    const paths = await createPaths()
    await ensureSharedConfig(paths)

    const config = await readSharedConfig(paths)
    expect(config).toEqual(defaultSharedConfig)
  })

  test("updates and persists a config value", async () => {
    const paths = await createPaths()

    await setSharedConfigValue(paths, "CLAW_API_KEY", "secret")

    const config = await readSharedConfig(paths)
    expect(config.CLAW_API_KEY).toBe("secret")
  })

  test("ignores comments and malformed env lines", async () => {
    const paths = await createPaths()
    await ensureSharedConfig(paths)
    await writeFile(
      paths.sharedConfigFile,
      "# comment\nCLAW_API_KEY=secret\nINVALID\n TELEGRAM_BOT_TOKEN = token \n",
      "utf8",
    )

    const config = await readSharedConfig(paths)
    expect(config).toEqual({
      CLAW_API_KEY: "secret",
      TELEGRAM_BOT_TOKEN: "token",
    })
  })
})

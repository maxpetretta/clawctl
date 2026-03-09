import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  bunExecutable,
  commandExists,
  dockerExecutable,
  gitExecutable,
  npmExecutable,
  uvExecutable,
} from "../tooling.ts"

describe("commandExists", () => {
  test("returns true for a real command on PATH", async () => {
    expect(await commandExists("sh")).toBe(true)
  })

  test("returns false for a missing command", async () => {
    expect(await commandExists("clawctl-command-that-does-not-exist")).toBe(false)
  })

  test("checks explicit filesystem paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawctl-tooling-"))
    const scriptPath = join(root, "tool.sh")
    await writeFile(scriptPath, "#!/bin/sh\nexit 0\n", "utf8")

    expect(await commandExists(scriptPath)).toBe(true)
    expect(await commandExists(join(root, "missing.sh"))).toBe(false)
  })

  test("resolves tool overrides from the environment", () => {
    process.env.CLAWCTL_NPM_BIN = "npm-custom"
    process.env.CLAWCTL_UV_BIN = "uv-custom"
    process.env.CLAWCTL_GIT_BIN = "git-custom"
    process.env.CLAWCTL_DOCKER_BIN = "docker-custom"
    process.env.CLAWCTL_BUN_BIN = "bun-custom"

    expect(npmExecutable()).toBe("npm-custom")
    expect(uvExecutable()).toBe("uv-custom")
    expect(gitExecutable()).toBe("git-custom")
    expect(dockerExecutable()).toBe("docker-custom")
    expect(bunExecutable()).toBe("bun-custom")

    process.env.CLAWCTL_NPM_BIN = undefined
    process.env.CLAWCTL_UV_BIN = undefined
    process.env.CLAWCTL_GIT_BIN = undefined
    process.env.CLAWCTL_DOCKER_BIN = undefined
    process.env.CLAWCTL_BUN_BIN = undefined
  })
})

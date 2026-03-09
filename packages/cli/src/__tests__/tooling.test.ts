import { afterEach, describe, expect, test } from "bun:test"

import { bunExecutable, dockerExecutable, gitExecutable, npmExecutable, uvExecutable } from "../tooling.ts"

afterEach(() => {
  process.env.CLAWCTL_NPM_BIN = undefined
  process.env.CLAWCTL_UV_BIN = undefined
  process.env.CLAWCTL_GIT_BIN = undefined
  process.env.CLAWCTL_DOCKER_BIN = undefined
  process.env.CLAWCTL_BUN_BIN = undefined
})

describe("tooling", () => {
  test("returns default executable names when no overrides are set", () => {
    expect(npmExecutable()).toBe("npm")
    expect(uvExecutable()).toBe("uv")
    expect(gitExecutable()).toBe("git")
    expect(dockerExecutable()).toBe("docker")
    expect(bunExecutable()).toBe("bun")
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
  })
})

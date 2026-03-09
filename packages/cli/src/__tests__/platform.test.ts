import { describe, expect, test } from "bun:test"

import { currentHostPlatform, requireV1HostPlatform } from "../platform.ts"

function withProcessValue<Key extends "arch" | "platform", Value>(
  key: Key,
  value: NodeJS.Process[Key],
  run: () => Value,
): Value {
  const original = process[key]
  Object.defineProperty(process, key, {
    configurable: true,
    value,
  })
  try {
    return run()
  } finally {
    Object.defineProperty(process, key, {
      configurable: true,
      value: original,
    })
  }
}

describe("platform", () => {
  test("maps the current host platform", () => {
    const platform = currentHostPlatform()
    expect(platform.os).toBe("darwin")
    expect(platform.arch).toBe("arm64")
  })

  test("enforces the v1 host platform restriction", () => {
    expect(requireV1HostPlatform()).toEqual({ os: "darwin", arch: "arm64" })
  })

  test("rejects unsupported hosts", () => {
    const run = () =>
      withProcessValue("arch", "x64", () => withProcessValue("platform", "linux", () => requireV1HostPlatform()))
    expect(run).toThrow("unsupported host platform for v1: linux-x64")
  })
})

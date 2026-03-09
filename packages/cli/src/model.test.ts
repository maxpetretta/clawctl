import { describe, expect, test } from "bun:test"
import { Option } from "effect"

import { resolveRuntime } from "./model.ts"

describe("resolveRuntime", () => {
  test("defaults to local", () => {
    expect(resolveRuntime(Option.none())).toBe("local")
  })

  test("returns an explicit runtime backend", () => {
    expect(resolveRuntime(Option.some("docker"))).toBe("docker")
  })
})

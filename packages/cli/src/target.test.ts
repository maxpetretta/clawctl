import { describe, expect, test } from "bun:test"

import { parseTargetReference } from "./target.ts"

describe("parseTargetReference", () => {
  test("parses implementation without a version", () => {
    expect(parseTargetReference("openclaw")).toEqual({ implementation: "openclaw" })
  })

  test("parses implementation with a version", () => {
    expect(parseTargetReference("openclaw@2026.3.7")).toEqual({
      implementation: "openclaw",
      version: "2026.3.7",
    })
  })

  test("rejects empty targets", () => {
    expect(() => parseTargetReference("   ")).toThrow("target must not be empty")
  })

  test("rejects malformed version references", () => {
    expect(() => parseTargetReference("openclaw@")).toThrow("invalid target reference")
    expect(() => parseTargetReference("@2026.3.7")).toThrow("invalid target reference")
  })
})

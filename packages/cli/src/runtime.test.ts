import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Option } from "effect"

import type { InstallRecord } from "./adapter/types.ts"
import { resolvePaths } from "./paths.ts"
import { activateSelection, ensureActiveChatTarget, pingText, resolveChatTarget, runChat } from "./runtime.ts"
import { setSharedConfigValue } from "./shared-config.ts"
import { writeCurrentSelection, writeInstallRecord } from "./state.ts"

const tempRoots: string[] = []

async function createPaths() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-runtime-"))
  tempRoots.push(root)
  return resolvePaths(root)
}

async function writeExecutable(destination: string, source: string) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, source, "utf8")
  await chmod(destination, 0o755)
}

function installRecord(paths: ReturnType<typeof resolvePaths>): InstallRecord {
  return {
    implementation: "openclaw",
    requestedVersion: "2026.3.7",
    resolvedVersion: "2026.3.7",
    backend: "local",
    installStrategy: "npm-package",
    installRoot: join(paths.installDir, "local", "openclaw", "2026.3.7"),
    entrypointCommand: [join(paths.rootDir, "bin", "openclaw")],
    platform: { os: "darwin", arch: "arm64" },
    sourceReference: "openclaw",
    verificationSummary: "registry-managed",
    installedAt: "2026-03-09T00:00:00.000Z",
    supportTier: "tier2",
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("runtime helpers", () => {
  test("resolveChatTarget uses the current selection", async () => {
    const paths = await createPaths()
    const record = installRecord(paths)
    await writeInstallRecord(paths, record)
    await writeCurrentSelection(paths, {
      implementation: record.implementation,
      version: record.resolvedVersion,
      backend: record.backend,
    })

    const resolved = await resolveChatTarget(paths, Option.none())
    expect(resolved.resolvedVersion).toBe("2026.3.7")
  })

  test("resolveChatTarget fails without a target or current selection", async () => {
    const paths = await createPaths()
    await expect(resolveChatTarget(paths, Option.none())).rejects.toThrow("no active claw selected")
  })

  test("ensureActiveChatTarget rejects unsupported capabilities", async () => {
    const paths = await createPaths()
    const record: InstallRecord = {
      ...installRecord(paths),
      implementation: "nanoclaw",
      installStrategy: "repo-bootstrap",
      installRoot: join(paths.installDir, "local", "nanoclaw", "main"),
      entrypointCommand: [],
      requestedVersion: "main",
      resolvedVersion: "main",
      supportTier: "tier3",
    }
    await writeInstallRecord(paths, record)

    await expect(ensureActiveChatTarget(paths, Option.some("nanoclaw"), "chat")).rejects.toThrow(
      "implementation does not support chat: nanoclaw",
    )
  })

  test("activateSelection writes rendered config and current state", async () => {
    const paths = await createPaths()
    const record = installRecord(paths)
    await writeInstallRecord(paths, record)
    await setSharedConfigValue(paths, "CLAW_API_KEY", "secret")

    const activated = await activateSelection(paths, {
      implementation: "openclaw",
      version: "2026.3.7",
    })

    expect(activated.resolvedVersion).toBe("2026.3.7")
    expect(
      await Bun.file(
        join(paths.runtimeDir, "local", "openclaw", "2026.3.7", "home", ".openclaw", "openclaw.json"),
      ).text(),
    ).toContain("openai-completions")
  })

  test("runChat renders config and normalizes output", async () => {
    const paths = await createPaths()
    const record = installRecord(paths)
    await writeExecutable(
      record.entrypointCommand[0] ?? join(paths.rootDir, "bin", "openclaw"),
      `#!/bin/sh
message=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ]; then
    message="$arg"
  fi
  prev="$arg"
done
printf '{"response":{"text":"reply:%s"}}\n' "$message"
`,
    )
    await writeInstallRecord(paths, record)
    await setSharedConfigValue(paths, "CLAW_API_KEY", "secret")

    const output = await runChat(paths, record, "hello-runtime")
    expect(output).toBe("reply:hello-runtime")
  })

  test("runChat rejects placeholder config and missing binaries", async () => {
    const paths = await createPaths()
    const record = installRecord(paths)
    await writeInstallRecord(paths, record)

    await expect(runChat(paths, record, "hello-runtime")).rejects.toThrow(
      "shared config key is missing or placeholder: CLAW_API_KEY",
    )

    await setSharedConfigValue(paths, "CLAW_API_KEY", "secret")
    await expect(runChat(paths, record, "hello-runtime")).rejects.toThrow("missing binary for openclaw")
  })

  test("runChat rejects empty adapter commands", async () => {
    const paths = await createPaths()
    const record: InstallRecord = {
      ...installRecord(paths),
      implementation: "nanoclaw",
      installStrategy: "repo-bootstrap",
      installRoot: join(paths.installDir, "local", "nanoclaw", "main"),
      entrypointCommand: [],
      requestedVersion: "main",
      resolvedVersion: "main",
      supportTier: "tier3",
    }
    await writeInstallRecord(paths, record)

    await expect(runChat(paths, record, "hello-runtime")).rejects.toThrow("missing binary for nanoclaw")
  })

  test("ensureActiveChatTarget activates supported targets", async () => {
    const paths = await createPaths()
    const record = installRecord(paths)
    await writeInstallRecord(paths, record)
    await setSharedConfigValue(paths, "CLAW_API_KEY", "secret")

    const activated = await ensureActiveChatTarget(paths, Option.some("openclaw"), "chat")
    expect(activated.resolvedVersion).toBe("2026.3.7")
  })

  test("pingText returns the one-shot ping prompt", () => {
    expect(pingText()).toBe("Reply with exactly the single word pong.")
  })
})

import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

async function runHelpRaw(args: string[]): Promise<string> {
  const cliRoot = new URL("../..", import.meta.url)
  const { stdout } = await execFileAsync("bun", ["run", "src/index.ts", ...args], {
    cwd: cliRoot,
    env: process.env,
  })
  return stdout.trim()
}

async function runHelp(args: string[]): Promise<string> {
  return (await runHelpRaw(args)).replaceAll(ansiPattern, "")
}

describe("clawctl root help", () => {
  test("running clawctl with no subcommand prints custom root help", async () => {
    const output = await runHelp([])
    expect(output).toContain("clawctl v2026.3.8")
    expect(output).toContain("Usage:\n  clawctl [OPTIONS] COMMAND")
    expect(output).toContain("Core Commands:\n  install")
    expect(output).toContain("Runtime Commands:\n  status")
    expect(output).toContain("Config Commands:\n  config  Read or update shared clawctl configuration.")
    expect(output).toContain("Global Options:\n  -h, --help  Print usage.")
    expect(output).toContain("Examples:\n  clawctl install openclaw")
    expect(output).toContain("Use 'clawctl COMMAND --help' for more information about a command.")
    expect(output).not.toContain("install [--runtime]")
  })

  test("clawctl --help prints the same custom root help", async () => {
    const output = await runHelp(["--help"])
    expect(output).toContain("Usage:\n  clawctl [OPTIONS] COMMAND")
    expect(output).toContain("Core Commands:\n  install")
    expect(output).toContain("Config Commands:\n  config  Read or update shared clawctl configuration.")
  })

  test("help output includes ansi styling for headers and options", async () => {
    const output = await runHelpRaw(["config", "--help"])
    expect(output).toContain("\u001B[1m\u001B[4mUsage:\u001B[0m")
    expect(output).toContain("\u001B[1mget\u001B[0m")
    expect(output).toContain("\u001B[1m-h, --help\u001B[0m")
    expect(output).toContain("\u001B[1m\u001B[4mOptions:\u001B[0m")
  })

  test("subcommand help is custom-rendered from metadata", async () => {
    const output = await runHelp(["install", "--help"])
    expect(output).toContain("Install a claw into the local clawctl store.")
    expect(output).toContain("Usage:\n  clawctl install [OPTIONS] TARGET")
    expect(output).toContain(
      "Arguments:\n  TARGET  Claw implementation, optionally pinned as <implementation>@<version>.",
    )
    expect(output).toContain(
      "Options:\n  --runtime <local|docker>  Choose a runtime backend. `local` is the only backend implemented today.",
    )
    expect(output).toContain("Examples:\n  clawctl install openclaw")
    expect(output).not.toContain("A user-defined piece of text.")
  })

  test("subcommand help still resolves when help follows positional args", async () => {
    const output = await runHelp(["install", "openclaw", "--help"])
    expect(output).toContain("Usage:\n  clawctl install [OPTIONS] TARGET")
    expect(output).toContain("clawctl install openclaw")
  })

  test("nested subcommand help is custom-rendered from metadata", async () => {
    const output = await runHelp(["config", "get", "--help"])
    expect(output).toContain("Print a shared configuration value.")
    expect(output).toContain("Usage:\n  clawctl config get KEY")
    expect(output).toContain("Arguments:\n  KEY  Shared configuration key to read or update.")
    expect(output).toContain("Options:\n  -h, --help  Print usage.")
    expect(output).not.toContain("A user-defined piece of text.")
  })
})

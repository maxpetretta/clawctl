import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function runHelp(args: string[]): Promise<string> {
  const cliRoot = new URL("../..", import.meta.url)
  const { stdout } = await execFileAsync("bun", ["run", "src/index.ts", ...args], {
    cwd: cliRoot,
    env: process.env,
  })
  return stdout.trim()
}

describe("clawctl root help", () => {
  test("running clawctl with no subcommand prints compact root help", async () => {
    const output = await runHelp([])
    expect(output).toContain("clawctl v2026.3.8")
    expect(output).toContain("Usage:\n  clawctl <command> [options]")
    expect(output).toContain("Commands:\n  install")
    expect(output).toContain("  config     Read or update shared clawctl configuration.")
    expect(output).toContain("Examples:\n  clawctl install openclaw")
    expect(output).toContain("Run 'clawctl <command> --help' for more information on a command.")
    expect(output).not.toContain("install [--runtime")
  })

  test("clawctl --help prints the same compact root help", async () => {
    const output = await runHelp(["--help"])
    expect(output).toContain("Usage:\n  clawctl <command> [options]")
    expect(output).toContain("Commands:\n  install")
    expect(output).toContain("  config     Read or update shared clawctl configuration.")
  })
})

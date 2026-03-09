import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function npmExecutable(): string {
  return process.env.CLAWCTL_NPM_BIN ?? "npm"
}

export function uvExecutable(): string {
  return process.env.CLAWCTL_UV_BIN ?? "uv"
}

export function gitExecutable(): string {
  return process.env.CLAWCTL_GIT_BIN ?? "git"
}

export function dockerExecutable(): string {
  return process.env.CLAWCTL_DOCKER_BIN ?? "docker"
}

export function bunExecutable(): string {
  return process.env.CLAWCTL_BUN_BIN ?? "bun"
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    if (command.includes("/")) {
      await access(command)
      return true
    }

    await execFileAsync("sh", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      env: process.env,
    })
    return true
  } catch {
    return false
  }
}

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

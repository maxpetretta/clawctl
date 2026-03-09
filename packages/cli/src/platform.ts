import type { PlatformSelector } from "./adapter/schema.ts"

export function currentHostPlatform(): PlatformSelector {
  return {
    os: process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "windows",
    arch: process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "other",
  }
}

export function requireV1HostPlatform(): PlatformSelector {
  const platform = currentHostPlatform()
  if (platform.os !== "darwin" || platform.arch !== "arm64") {
    throw new Error(`unsupported host platform for v1: ${platform.os}-${platform.arch}`)
  }
  return platform
}

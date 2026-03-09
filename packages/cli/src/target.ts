export type TargetReference = {
  implementation: string
  version?: string
}

export function parseTargetReference(target: string): TargetReference {
  const trimmed = target.trim()
  if (trimmed.length === 0) {
    throw new Error("target must not be empty")
  }

  const atIndex = trimmed.lastIndexOf("@")
  if (atIndex < 0) {
    return { implementation: trimmed }
  }

  const implementation = trimmed.slice(0, atIndex).trim()
  const version = trimmed.slice(atIndex + 1).trim()

  if (implementation.length === 0 || version.length === 0) {
    throw new Error(`invalid target reference: ${target}`)
  }

  return { implementation, version }
}

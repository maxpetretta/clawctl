import { Data, Effect } from "effect"

export class ClawctlUserError extends Data.TaggedError("ClawctlUserError")<{
  action: string
  message: string
}> {}

export class ClawctlSystemError extends Data.TaggedError("ClawctlSystemError")<{
  action: string
  cause: unknown
  message: string
}> {}

export type ClawctlError = ClawctlSystemError | ClawctlUserError

export function userError(action: string, message: string): ClawctlUserError {
  return new ClawctlUserError({
    action,
    message,
  })
}

export function toClawctlSystemError(action: string, cause: unknown): ClawctlSystemError {
  return new ClawctlSystemError({
    action,
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })
}

export function trySystemPromise<A>(action: string, run: () => Promise<A>): Effect.Effect<A, ClawctlSystemError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toClawctlSystemError(action, cause),
  })
}

export function withSystemError<A, E, R>(
  action: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ClawctlSystemError, R> {
  return Effect.mapError(effect, (cause) => toClawctlSystemError(action, cause))
}

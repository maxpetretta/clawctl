import * as Schema from "effect/Schema"

export const PlatformSelectorSchema = Schema.Struct({
  arch: Schema.String,
  libc: Schema.optional(Schema.String),
  os: Schema.String,
})

export const InstallRecordSchema = Schema.Struct({
  backend: Schema.String,
  entrypointCommand: Schema.Array(Schema.String),
  implementation: Schema.String,
  installRoot: Schema.String,
  installStrategy: Schema.String,
  installedAt: Schema.String,
  platform: PlatformSelectorSchema,
  requestedVersion: Schema.String,
  resolvedVersion: Schema.String,
  sourceReference: Schema.String,
  supportTier: Schema.String,
  verificationSummary: Schema.optional(Schema.String),
})

export const CurrentSelectionSchema = Schema.Struct({
  backend: Schema.String,
  implementation: Schema.String,
  version: Schema.String,
})

export const parseInstallRecordJson = Schema.decodeUnknownSync(Schema.parseJson(InstallRecordSchema))
export const parseCurrentSelectionJson = Schema.decodeUnknownSync(Schema.parseJson(CurrentSelectionSchema))
export const stringifyInstallRecordJson = Schema.encodeSync(Schema.parseJson(InstallRecordSchema))
export const stringifyCurrentSelectionJson = Schema.encodeSync(Schema.parseJson(CurrentSelectionSchema))

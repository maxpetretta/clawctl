import { BunContext } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { ClawctlMaintenanceLive } from "./maintenance-service.ts"
import { makeClawctlPathsLayer } from "./paths-service.ts"
import { ClawctlRuntimeLive } from "./runtime-service.ts"
import { ClawctlStoreLive } from "./store-service.ts"

function makeBaseLayer(rootDir: string) {
  const platformLayer = BunContext.layer
  const pathsLayer = makeClawctlPathsLayer(rootDir).pipe(Layer.provide(platformLayer))
  return Layer.mergeAll(platformLayer, pathsLayer)
}

function makeStoreLayer(rootDir: string) {
  const baseLayer = makeBaseLayer(rootDir)
  const storeLayer = ClawctlStoreLive.pipe(Layer.provide(baseLayer))
  return Layer.mergeAll(baseLayer, storeLayer)
}

function makeRuntimeLayer(rootDir: string) {
  const storeLayer = makeStoreLayer(rootDir)
  const runtimeLayer = ClawctlRuntimeLive.pipe(Layer.provide(storeLayer))
  return Layer.mergeAll(storeLayer, runtimeLayer)
}

export function makeMaintenanceLayer(rootDir: string) {
  const storeLayer = makeStoreLayer(rootDir)
  const maintenanceLayer = ClawctlMaintenanceLive.pipe(Layer.provide(storeLayer))
  return Layer.mergeAll(storeLayer, maintenanceLayer)
}

export function makePathsLayer(rootDir: string) {
  return makeBaseLayer(rootDir)
}

export function makeStoreTestLayer(rootDir: string) {
  return makeStoreLayer(rootDir)
}

export function makeRuntimeTestLayer(rootDir: string) {
  return makeRuntimeLayer(rootDir)
}

export function runWithLayer<A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

import { Layer } from "effect"

import { ClawctlInstallerLive } from "./installer-service.ts"
import { ClawctlMaintenanceLive } from "./maintenance-service.ts"
import { ClawctlPathsLive } from "./paths-service.ts"
import { ClawctlRuntimeLive } from "./runtime-service.ts"
import { ClawctlStoreLive } from "./store-service.ts"

const pathsLayer = ClawctlPathsLive
const storeLayer = ClawctlStoreLive.pipe(Layer.provide(pathsLayer))
const storeDependencies = Layer.mergeAll(pathsLayer, storeLayer)

export const fullDependencyLayer = Layer.mergeAll(
  pathsLayer,
  storeLayer,
  ClawctlInstallerLive.pipe(Layer.provide(storeDependencies)),
  ClawctlMaintenanceLive.pipe(Layer.provide(storeDependencies)),
  ClawctlRuntimeLive.pipe(Layer.provide(storeDependencies)),
)

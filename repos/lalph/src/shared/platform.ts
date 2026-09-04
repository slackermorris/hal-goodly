import { NodeServices } from "@effect/platform-node"

// TODO: switch between node and bun services based on environment
export const PlatformServices = NodeServices.layer

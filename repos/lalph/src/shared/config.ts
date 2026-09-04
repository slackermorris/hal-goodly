import { Config } from "effect"
import { parseCommand } from "./child-process.ts"

export const configEditor = Config.string("LALPH_EDITOR").pipe(
  Config.orElse(() => Config.string("EDITOR")),
  Config.map(parseCommand),
  Config.withDefault(["nano"]),
)

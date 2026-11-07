import { Schema } from "effect";

export class EntryTooLarge extends Schema.TaggedErrorClass<EntryTooLarge>()(
  "EntryTooLarge",
  {
    bytes: Schema.Int,
    limit: Schema.Int,
  },
) {}

export class UnknownEventKind extends Schema.TaggedErrorClass<UnknownEventKind>()(
  "UnknownEventKind",
  { kind: Schema.String },
) {}

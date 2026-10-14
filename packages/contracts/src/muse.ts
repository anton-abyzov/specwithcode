import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
export const MuseSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  binaryPath: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("muse")),
    Schema.annotate({
      title: "Binary Path",
      description:
        "Official Muse Code CLI path. Install from dev.meta.ai/docs/muse-code and sign in with muse, then refresh. Wonder Full needs Power or Maximum Usage. Check Contributor mode in Muse settings before sending private code.",
    }),
  ),
}).pipe(Schema.annotate({ providerSettingsFormSchema: { order: ["binaryPath"] } }));
export type MuseSettings = typeof MuseSettings.Type;

import * as Effect from "effect/Effect";
import * as Record from "effect/Record";

export const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

type TaggedErrorTag<E> = Extract<E, { readonly _tag: string }>["_tag"];

type MapErrorTagCases<E> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
    traceId: string,
  ) => unknown;
};

type MappedTagError<Cases> = Cases[keyof Cases] extends (
  ...args: ReadonlyArray<never>
) => infer Error
  ? Error
  : never;

type CatchTagCases<E, Cases> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
  ) => Effect.Effect<never, MappedTagError<Cases>>;
} & (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never });

export function mapErrorTags<
  E,
  Cases extends MapErrorTagCases<E> &
    (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never }),
>(cases: Cases) {
  const catchCases = Record.map(
    cases as Record.ReadonlyRecord<
      string,
      (error: never, traceId: string) => MappedTagError<Cases>
    >,
    (makeError) => (error: never) =>
      currentTraceId.pipe(Effect.flatMap((traceId) => Effect.fail(makeError(error, traceId)))),
  ) as CatchTagCases<E, Cases>;

  return <A, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>, R> =>
    // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
    Effect.catchTags(self, catchCases) as Effect.Effect<
      A,
      Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>,
      R
    >;
}

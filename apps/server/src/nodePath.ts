import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** Native path semantics for synchronous adapter APIs and test fixtures. */
export const nodePath = {
  ...Effect.runSync(Effect.provide(Path.Path, NodePath.layer)),
  posix: Effect.runSync(Effect.provide(Path.Path, NodePath.layerPosix)),
  win32: Effect.runSync(Effect.provide(Path.Path, NodePath.layerWin32)),
};
export const {
  join,
  dirname,
  basename,
  resolve,
  relative,
  isAbsolute,
  extname,
  normalize,
  parse,
  format,
  sep,
} = nodePath;

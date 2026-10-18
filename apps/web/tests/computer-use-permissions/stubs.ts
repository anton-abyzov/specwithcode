// Stand-ins for the machine lookups the permission views read.
import { Atom } from "effect/reactivity";

export const primaryEnvironmentIdAtom = Atom.make<string | null>("m4");

export function useEnvironment(environmentId: string | null) {
  return environmentId === "m1" ? { label: "M1" } : { label: "M4 Max" };
}

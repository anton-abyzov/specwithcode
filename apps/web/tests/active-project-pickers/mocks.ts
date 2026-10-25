import { Atom } from "effect/reactivity";
const empty = Atom.make(null);
export const projectFaviconUrlAtom = () => empty;

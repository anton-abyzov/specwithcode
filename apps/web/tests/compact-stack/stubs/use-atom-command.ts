import { AsyncResult } from "effect/reactivity";
export const useAtomCommand = () => async () => AsyncResult.success({ sequence: 1 });

import { createDesignAtoms } from "@specweave-studio/client-runtime/state/design";
import { connectionAtomRuntime } from "../connection/runtime";

export const design = createDesignAtoms(connectionAtomRuntime);

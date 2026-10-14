import { createManagedUpdateAtoms } from "@specweave-studio/client-runtime/state/managedUpdates";
import { connectionAtomRuntime } from "../connection/runtime";
export const managedUpdates = createManagedUpdateAtoms(connectionAtomRuntime);

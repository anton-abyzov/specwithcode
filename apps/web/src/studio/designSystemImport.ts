import { createDesignSystemImportAtoms } from "@specweave-studio/client-runtime/state/designSystemImport";
import { connectionAtomRuntime } from "../connection/runtime";

export const designSystemImport = createDesignSystemImportAtoms(connectionAtomRuntime);

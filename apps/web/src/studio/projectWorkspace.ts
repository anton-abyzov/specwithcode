import { createProjectWorkspaceAtoms } from "@specweave-studio/client-runtime/state/project-workspace";
import { connectionAtomRuntime } from "../connection/runtime";
export const projectWorkspace = createProjectWorkspaceAtoms(connectionAtomRuntime);

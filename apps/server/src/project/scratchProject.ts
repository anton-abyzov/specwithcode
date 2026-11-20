// @effect-diagnostics nodeBuiltinImport:off -- a pure path comparison, also run where no Effect Path service exists.
/**
 * A chat started without a project lives in the data folder's Scratch project
 * ("No project"), in a folder of its own. That project is a container, not a
 * project: chats in it share no goal, instructions, memory or knowledge, so two
 * unrelated chats never read each other's notes.
 *
 * @module scratchProject
 */
import { canonicalStudioPath } from "@specweave-studio/shared/studioIdentity";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** The Scratch folder's name under the data folder (see ManagedProjectFolders). */
export const SCRATCH_FOLDER = "scratch";

/** Whether a project root is the data folder's Scratch folder, also under a migrated legacy root. */
export const isScratchWorkspaceRoot = (baseDir: string, workspaceRoot: string): boolean =>
  canonicalStudioPath(NodePath.resolve(workspaceRoot), NodeOS.homedir()) ===
  NodePath.resolve(baseDir, SCRATCH_FOLDER);

/** What a chat's agent is told in place of a project's context. */
export const CHAT_CONTEXT_ROLE =
  "This is a chat without a project. Nothing in it is shared with other chats: there is no project goal, instructions, memory or knowledge, and its folder is its own. Do not save project memory here. If the user wants this work to share context, they can move the chat into a project (Move to project… keeps the conversation and folder); lasting facts about the user belong with their personal assistant.";

/** Why a chat cannot write project memory. */
export const CHAT_MEMORY_REFUSAL =
  "This chat has no project, so it has no project memory: nothing written here would be private to it. Keep notes in the chat's own folder, or ask the user to move the chat into a project with Move to project….";

import remarkGfm from "remark-gfm";
import type { Pluggable } from "unified";

/**
 * GFM as chat renders it. A single `~` is not strikethrough: agents write home paths
 * (`~/.local/... ~/.kube/...`) far more often than `~struck~`, and GitHub itself only
 * strikes `~~text~~`.
 */
export const CHAT_REMARK_GFM: Pluggable = [remarkGfm, { singleTilde: false }];

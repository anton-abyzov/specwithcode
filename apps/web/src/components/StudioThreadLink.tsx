import type { EnvironmentId } from "@specweave-studio/contracts";

import { useOpenThread } from "../hooks/useOpenThread";
import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { formatStudioThreadLink, resolveStudioThreadLink } from "../studio/studioThreadLinks";
import { DeadThreadLinkChip, ThreadLinkChipLink } from "./ThreadLinkChip";

/**
 * A coordinator's `studio://thread/<id>` link inside chat markdown. It opens like
 * any other thread chip: in the project's right panel inside a project, full page
 * elsewhere. A link to a deleted thread, or one this machine does not have, reads
 * as a muted chip that says so.
 */
export function StudioThreadLink(props: {
  environmentId: EnvironmentId | null;
  /** Thread IDs the link may name, most likely first (see parseStudioThreadHref). */
  candidates: readonly string[];
  label: string;
  /** The link itself named this environment: a thread on another machine. */
  linkedEnvironment?: boolean;
}) {
  const threads = useThreadShells(props.environmentId !== null);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { openInProject } = useOpenThread();
  // Without an environment, or before this machine's threads have loaded, nothing
  // can say the thread is missing yet: the link reads as its label.
  if (props.environmentId === null) return <span>{props.label}</span>;
  const resolved = resolveStudioThreadLink(
    threads,
    props.candidates,
    props.label,
    props.environmentId,
  );
  // A link to another machine's thread keeps naming that machine when copied.
  const linkEnvironment = props.linkedEnvironment ? props.environmentId : undefined;
  if (resolved.kind !== "thread") {
    if (resolved.kind !== "deleted" && !bootstrapped) return <span>{props.label}</span>;
    const elsewhere =
      props.linkedEnvironment === true &&
      !threads.some((thread) => thread.environmentId === props.environmentId);
    return (
      <DeadThreadLinkChip
        label={props.label}
        reason={resolved.kind === "deleted" ? "deleted" : elsewhere ? "elsewhere" : "missing"}
        copyMarkdown={formatStudioThreadLink(
          props.candidates[0] ?? props.label,
          props.label,
          linkEnvironment,
        )}
      />
    );
  }
  const thread = resolved.shell;
  return (
    <ThreadLinkChipLink
      thread={thread}
      label={props.label}
      onPlainClick={() =>
        openInProject({ environmentId: thread.environmentId, threadId: thread.id })
      }
      copyMarkdown={formatStudioThreadLink(
        thread.id,
        thread.title.trim() || props.label,
        linkEnvironment,
      )}
    />
  );
}

/**
 * A link to a page on a provider's site (a claude.ai artifact, a ChatGPT share)
 * that reached a reply. Reports live in the project and open in the app's own
 * viewer, so this is not drawn as a branded link: it is a neutral document chip
 * that says where the page lives, and its menu offers to save it here first.
 */
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { CopyIcon, ExternalLinkIcon, FileInputIcon, FileTextIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  type ProviderHostedDocument,
  providerHostedDocumentExplanation,
  providerHostedDocumentImportRequest,
  providerHostedDocumentNoun,
} from "../../providerHostedDocument";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { Tip } from "../studio/shell/Tip";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

const COORDINATOR_THREAD = /^project-coordinator:([^:]+)$/;

function appended(prompt: string, request: string): string {
  const current = prompt.trimEnd();
  return current.length === 0 ? request : `${current}\n\n${request}`;
}

/**
 * Puts the request to save the page as a report in the composer of the thread
 * that shows it, after anything already typed there. Nothing is sent.
 */
export function draftOutsideDocumentImport(
  threadRef: ScopedThreadRef,
  document: ProviderHostedDocument,
  label: string,
): void {
  const request = providerHostedDocumentImportRequest(document, label);
  const coordinatorProject = COORDINATOR_THREAD.exec(threadRef.threadId)?.[1];
  if (coordinatorProject !== undefined) {
    getProjectCoordinatorComposer(threadRef.environmentId, coordinatorProject).setPrompt((prompt) =>
      appended(prompt, request),
    );
  } else {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, appended(store.getComposerDraft(threadRef)?.prompt ?? "", request));
  }
  toastManager.add({
    type: "success",
    title: "Added to the composer",
    description: "Send it, and the agent saves the page as a report in this project.",
  });
}

export function OutsideDocumentLink(props: {
  document: ProviderHostedDocument;
  label: string;
  /** Hidden where no thread composer can take the request. */
  onSaveToProject?: (() => void) | undefined;
  onOpen: () => void;
  onCopy: () => void;
  copyMarkdown?: string | undefined;
}) {
  const { document } = props;
  const title = props.label.trim() || providerHostedDocumentNoun(document);
  const explanation = providerHostedDocumentExplanation(document);
  return (
    <Menu>
      <Tip label={explanation} side="top">
        <MenuTrigger
          // The chip's look is the thread-link chip's, so it renders that native button.
          render={<button type="button" className="sws-thread-link" />}
          data-outside-document={document.provider}
          data-markdown-copy={props.copyMarkdown}
          aria-label={`${title}, ${providerHostedDocumentNoun(document)} outside SpecWithCode`}
        >
          <FileTextIcon className="sws-thread-link-icon" aria-hidden />
          <span className="sws-thread-link-title">{title}</span>
          <span className="sws-outside-document-tag" aria-hidden>
            {`outside · ${document.provider}`}
          </span>
        </MenuTrigger>
      </Tip>
      <MenuPopup align="start" side="bottom" className="max-w-80">
        <p className="px-2 pt-1.5 pb-1 text-muted-foreground text-xs">{explanation}</p>
        <MenuSeparator />
        {props.onSaveToProject ? (
          <MenuItem onClick={props.onSaveToProject} data-outside-document-action="save">
            <FileInputIcon aria-hidden />
            Save to this project
          </MenuItem>
        ) : null}
        <MenuItem onClick={props.onOpen} data-outside-document-action="open">
          <ExternalLinkIcon aria-hidden />
          {`Open in ${document.provider}`}
        </MenuItem>
        <MenuItem onClick={props.onCopy} data-outside-document-action="copy">
          <CopyIcon aria-hidden />
          Copy link
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

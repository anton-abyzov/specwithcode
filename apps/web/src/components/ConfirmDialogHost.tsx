import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  respondToConfirmDialog,
  subscribeConfirmDialog,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message);
  const active = state.status === "idle" ? null : state;
  // A three-way choice starts on its default (the confirm button), so Enter
  // picks it and not a row of the list under the question. A two-way question
  // with a list starts on Cancel (Later) for the same reason, never on a row.
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const initialFocus = active?.alternateLabel
    ? confirmRef
    : active !== null && active.details
      ? cancelRef
      : null;
  const confirmVariant = active?.variant ?? "default";
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup {...(initialFocus ? { initialFocus } : {})}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {state.status !== "idle" && state.details ? (
          <div className="px-6 pb-4">{state.details}</div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button ref={cancelRef} variant="outline" />}>
            {active?.cancelIcon}
            {active?.cancelLabel ?? "Cancel"}
          </AlertDialogClose>
          {active?.alternateLabel ? (
            <Button
              variant={active.alternateVariant ?? "outline"}
              onClick={() => respondToConfirmDialog("alternate")}
            >
              {active.alternateIcon}
              {active.alternateLabel}
            </Button>
          ) : null}
          <Button ref={confirmRef} variant={confirmVariant} onClick={onConfirm}>
            {active?.confirmIcon}
            {active?.confirmLabel ?? "Confirm"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

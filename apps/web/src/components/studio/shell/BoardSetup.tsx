/**
 * The Board tab without a board (1396 AC-11, AC-12): SpecWeave is off, or its
 * setup is unfinished because plans were written before it. One press runs
 * setup: what it adds is listed before the press, and a folder without Git
 * says first that Git starts too. The states are the card's (AC-05). With
 * SpecWeave off the example board sits beside the explainer.
 *
 * Pure: Project settings' connected row (`BoardSpecweaveSetup`) gives it the
 * project's state and the presses, and the board fixture renders it as is.
 */
import { useId } from "react";

import { Button } from "../../ui/button";
import {
  SPECWEAVE_ADDS,
  SPECWEAVE_ADDS_LABEL,
  SPECWEAVE_GIT_SENTENCE,
  SPECWEAVE_INSTALL_NODE,
  SPECWEAVE_NOT_NOW,
  SPECWEAVE_RETRY,
  SPECWEAVE_REVIEW_NOTE,
  SPECWEAVE_SETTING_UP,
  boardSetupCopy,
  specweaveStateReason,
  type BoardSetupKind,
  type SpecweaveShownState,
} from "../specweaveSetup.logic";
import { BoardExample } from "./BoardExample";

export interface BoardSetupViewProps {
  readonly kind: BoardSetupKind;
  /** With `unfinished`: how many plans are there and the first titles. */
  readonly unfinished?:
    | { readonly count: number; readonly titles: ReadonlyArray<string> }
    | undefined;
  /** False: the folder is not a Git repository, and the press starts one. */
  readonly gitRepository: boolean | undefined;
  /** Asking, Setting up, Failed, Node.js missing or Not allowed. */
  readonly shown: SpecweaveShownState;
  /** "Not now" is offered: SpecWeave is off, not declined yet, and the server can store it. */
  readonly offerNotNow: boolean;
  /** The person cannot act here (no connection, no access to operate). */
  readonly disabled?: boolean | undefined;
  readonly notNowError?: string | null | undefined;
  readonly onSetUp: () => void;
  readonly onNotNow: () => void;
  readonly onInstallNode: () => void;
  /** Names the example's layout instead of measuring (tests, fixtures). */
  readonly exampleColumns?: boolean | undefined;
}

export function BoardSetupView(props: BoardSetupViewProps) {
  const titleId = useId();
  const copy = boardSetupCopy({
    kind: props.kind,
    unfinished: props.unfinished,
    gitRepository: props.gitRepository,
  });
  const { state } = props.shown;
  const reason = specweaveStateReason(props.shown);
  const settingUp = state === "setting_up";
  const disabled = props.disabled === true;
  return (
    <div className="sws-board-setup-wrap" data-kind={props.kind}>
      <section
        className="sws-board-setup"
        aria-labelledby={titleId}
        aria-busy={settingUp || undefined}
        data-state={state}
      >
        <h3 id={titleId}>{copy.heading}</h3>
        <p>{copy.text}</p>
        {copy.titles.length > 0 ? (
          <ul className="sws-board-setup-titles" aria-label="Plans found">
            {copy.titles.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        ) : null}
        <div className="sws-board-setup-adds">
          <p className="sws-board-setup-label">{SPECWEAVE_ADDS_LABEL}</p>
          <ul>
            {SPECWEAVE_ADDS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>{SPECWEAVE_REVIEW_NOTE}</p>
        </div>
        {props.gitRepository === false ? (
          <p data-specweave-git="">{SPECWEAVE_GIT_SENTENCE}</p>
        ) : null}
        {settingUp ? (
          <p role="status" className="sws-board-setup-status">
            {SPECWEAVE_SETTING_UP}
          </p>
        ) : null}
        {reason ? (
          <p role="alert" className="sws-board-setup-reason">
            {reason}
          </p>
        ) : null}
        {props.notNowError ? (
          <p role="alert" className="sws-board-setup-reason">
            {props.notNowError}
          </p>
        ) : null}
        <div className="sws-board-setup-actions">
          {state === "node_missing" ? (
            <Button size="sm" disabled={disabled} onClick={props.onInstallNode}>
              {SPECWEAVE_INSTALL_NODE}
            </Button>
          ) : null}
          {state === "asking" || state === "setting_up" ? (
            <Button size="sm" disabled={disabled || settingUp} onClick={props.onSetUp}>
              {copy.button}
            </Button>
          ) : null}
          {state === "failed" || state === "node_missing" ? (
            <Button
              size="sm"
              variant={state === "failed" ? "default" : "outline"}
              disabled={disabled}
              onClick={props.onSetUp}
            >
              {SPECWEAVE_RETRY}
            </Button>
          ) : null}
          {props.offerNotNow && props.kind === "off" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || settingUp}
              onClick={props.onNotNow}
            >
              {SPECWEAVE_NOT_NOW}
            </Button>
          ) : null}
        </div>
      </section>
      {props.kind === "off" ? <BoardExample columns={props.exampleColumns} /> : null}
    </div>
  );
}

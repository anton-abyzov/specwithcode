// The whiteboard view over an in-memory file. Query:
//   ?file=empty|lifecycle|stored   an empty drawing, the vskill lifecycle diagram
//                                  (served as /lifecycle.excalidraw), or the text
//                                  a previous page saved in sessionStorage
//   ?theme=light|dark
// The page also stands in for the app around the editor: a capture-phase key
// listener on window records every key that reaches it, as an app shortcut
// would, and claims it. Nothing typed in the editor may arrive there.
import { whiteboardRevision } from "@specweave-studio/shared/officeWhiteboard";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { WhiteboardView } from "~/components/office/whiteboard/WhiteboardView";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);

interface FixtureWindow extends Window {
  appKeys: string[];
  saves: string[];
  disk: string;
  externalWrite?: (text: string) => void;
  setTheme?: (theme: "light" | "dark") => void;
  /** Closes the editor, as switching to another file does, and opens it again on the disk text. */
  closeBoard?: () => void;
  openBoard?: () => void;
  /** While set, a save waits for releaseSaves() before it checks and writes. */
  holdSaves?: boolean;
  releaseSaves?: () => void;
}
const fixture = window as unknown as FixtureWindow;
fixture.appKeys = [];
fixture.saves = [];
window.addEventListener(
  "keydown",
  (event) => {
    fixture.appKeys.push(
      `${event.metaKey ? "Meta+" : ""}${event.ctrlKey ? "Control+" : ""}${event.key}`,
    );
    event.preventDefault();
  },
  true,
);

async function initialText(): Promise<string> {
  const file = params.get("file") ?? "empty";
  if (file === "lifecycle") return (await fetch("/lifecycle.excalidraw")).text();
  if (file === "stored") return sessionStorage.getItem("whiteboard") ?? "";
  return "";
}

function Board(props: { readonly initial: string }): ReactNode {
  const [text, setText] = useState(props.initial);
  const [theme, setTheme] = useState<"light" | "dark">(dark ? "dark" : "light");
  const [shown, setShown] = useState(true);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    fixture.disk = props.initial;
    fixture.externalWrite = (next) => {
      fixture.disk = next;
      setText(next);
    };
    fixture.closeBoard = () => setShown(false);
    fixture.openBoard = () => {
      setText(fixture.disk);
      setGeneration((value) => value + 1);
      setShown(true);
    };
    fixture.setTheme = (next) => {
      document.documentElement.classList.toggle("dark", next === "dark");
      setTheme(next);
    };
  }, [props.initial]);
  if (!shown) return <p data-board-closed>closed</p>;
  return (
    <WhiteboardView
      key={generation}
      draftKey="fixture"
      text={text}
      name="fixture"
      mode={theme}
      frameUrl="/whiteboard.html"
      onReload={() => setText(fixture.disk)}
      onSave={async (contents, expectedRevision) => {
        if (fixture.holdSaves) {
          await new Promise<void>((release) => {
            fixture.releaseSaves = release;
          });
        }
        // The guarded write: refused when the file moved since the editor read it.
        if (whiteboardRevision(fixture.disk) !== expectedRevision) return "conflict";
        fixture.disk = contents;
        fixture.saves.push(contents);
        sessionStorage.setItem("whiteboard", contents);
        return true;
      }}
    />
  );
}

void initialText().then((initial) =>
  createRoot(document.getElementById("root")!).render(
    <main className="flex h-screen flex-col bg-background text-foreground">
      <Board initial={initial} />
    </main>,
  ),
);

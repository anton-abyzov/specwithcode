import {
  Excalidraw,
  exportScene,
  getSceneVersion,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { parseWhiteboard } from "@specweave-studio/shared/officeWhiteboard";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { WhiteboardFrameHost, WhiteboardTheme } from "../bridge";

/** What a save would change: elements, images and the view settings Excalidraw keeps in a file. */
function changeKey(
  elements: Parameters<typeof getSceneVersion>[0],
  appState: AppState,
  files: BinaryFiles,
): string {
  return [
    getSceneVersion(elements),
    Object.keys(files).length,
    appState.viewBackgroundColor,
    appState.gridModeEnabled,
    appState.gridSize,
    appState.gridStep,
    appState.name ?? "",
  ].join("|");
}

/** The scene a file holds, restored the way Excalidraw restores a file it opens. */
function sceneFrom(text: string): ExcalidrawInitialDataState {
  const parsed = parseWhiteboard(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const elements = restoreElements(parsed.file.elements as never, null, { repairBindings: true });
  const appState = restoreAppState(parsed.file.appState as never, null);
  return {
    elements,
    appState: { ...appState, isLoading: false },
    // Only images the file carries as data URLs; the rest stay in the file untouched.
    files: parsed.file.files as unknown as BinaryFiles,
    scrollToContent: true,
  };
}

/** The scene and settings an export draws: the background on, 16 px around, the editor's theme. */
function exportInput(api: ExcalidrawImperativeAPI) {
  const appState = api.getAppState();
  return {
    data: {
      elements: api.getSceneElements(),
      appState: { viewBackgroundColor: appState.viewBackgroundColor },
      files: api.getFiles(),
    },
    config: {
      padding: 16,
      canvasBackgroundColor: appState.viewBackgroundColor,
      theme: appState.theme,
    },
  } as const;
}

export function WhiteboardCanvas(props: { readonly host: WhiteboardFrameHost }): ReactNode {
  const { host } = props;
  const [theme, setTheme] = useState<WhiteboardTheme>(host.theme);
  const [viewOnly, setViewOnly] = useState(host.viewOnly);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const initialData = useMemo(() => {
    try {
      return sceneFrom(host.text);
    } catch (error) {
      host.onError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [host]);
  // The first change Excalidraw reports is the file as it opened: not an edit.
  const baseline = useRef<string | null>(null);
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (api === null) return;
    host.onReady({
      load: (text) => {
        const scene = sceneFrom(text);
        baseline.current = null;
        api.updateScene({
          elements: scene.elements ?? [],
          appState: scene.appState as never,
          captureUpdate: "NEVER" as never,
        });
        const files = Object.values(scene.files ?? {});
        if (files.length > 0) api.addFiles(files);
        api.history.clear();
      },
      setTheme,
      setViewOnly,
      serialize: () =>
        serializeAsJSON(
          api.getSceneElementsIncludingDeleted(),
          api.getAppState(),
          api.getFiles(),
          "local",
        ),
      exportPng: () => exportScene({ ...exportInput(api), type: "png" }),
      exportSvg: async () => {
        const svg = await exportScene({ ...exportInput(api), type: "svg" });
        return new XMLSerializer().serializeToString(svg);
      },
      focus: () => {
        window.focus();
        document.querySelector<HTMLElement>(".excalidraw")?.focus();
      },
    });
  }, [api, host]);

  if (initialData === null) return null;
  return (
    <Excalidraw
      onExcalidrawAPI={setApi}
      initialData={initialData}
      theme={theme}
      viewModeEnabled={viewOnly}
      // The frame holds nothing else, so keys reach the editor wherever focus sits in it.
      handleKeyboardGlobally
      autoFocus
      detectScroll={false}
      aiEnabled={false}
      // Embeds and links are off: a drawing is data, and never opens a page by itself.
      validateEmbeddable={() => false}
      onLinkOpen={(_element, event) => event.preventDefault()}
      UIOptions={{
        canvasActions: {
          // The theme follows the app; files are saved by the app.
          toggleTheme: null,
          loadScene: false,
          saveToActiveFile: false,
          export: { saveFileToDisk: true },
          saveAsImage: true,
          clearCanvas: true,
          changeViewBackgroundColor: true,
        },
      }}
      onChange={(elements, appState, files) => {
        const key = changeKey(elements, appState, files);
        if (baseline.current === null) {
          baseline.current = key;
          last.current = key;
          return;
        }
        if (key === last.current) return;
        last.current = key;
        host.onEdit();
      }}
    />
  );
}

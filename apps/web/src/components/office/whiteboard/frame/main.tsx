/**
 * Entry of `whiteboard.html`, the frame the whiteboard editor runs in. Fonts
 * and other Excalidraw assets come from the app's own bundle
 * (`excalidraw-assets/`), never a CDN, so the editor draws with no network.
 */
import "./assetPath";

import { createRoot } from "react-dom/client";

import {
  WHITEBOARD_HOST_PROPERTY,
  type WhiteboardFrameElement,
  type WhiteboardFrameHost,
} from "../bridge";

function hostOf(): WhiteboardFrameHost | null {
  try {
    return (
      (window.frameElement as WhiteboardFrameElement | null)?.[WHITEBOARD_HOST_PROPERTY] ?? null
    );
  } catch {
    return null;
  }
}

function mount(attempt = 0): void {
  const host = hostOf();
  if (host === null) {
    // The host sets its handle as the frame mounts; give it a few frames.
    if (attempt < 120) requestAnimationFrame(() => mount(attempt + 1));
    return;
  }
  document.documentElement.dataset.theme = host.theme;
  // Excalidraw builds its font URLs as its module loads, so it is imported only
  // once the asset path is set; a static import could be evaluated first.
  void Promise.all([import("./WhiteboardCanvas"), import("@excalidraw/excalidraw/index.css")]).then(
    ([{ WhiteboardCanvas }]) => {
      createRoot(document.getElementById("whiteboard")!).render(<WhiteboardCanvas host={host} />);
    },
    (error: unknown) => host.onError(error instanceof Error ? error.message : String(error)),
  );
}

mount();

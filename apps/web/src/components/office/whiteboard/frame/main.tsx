/**
 * Entry of `whiteboard.html`, the frame the whiteboard editor runs in. Fonts
 * and other Excalidraw assets come from the app's own bundle
 * (`excalidraw-assets/`), never a CDN, so the editor draws with no network.
 */
import "@excalidraw/excalidraw/index.css";

import { createRoot } from "react-dom/client";

import {
  WHITEBOARD_HOST_PROPERTY,
  type WhiteboardFrameElement,
  type WhiteboardFrameHost,
} from "../bridge";
import { WhiteboardCanvas } from "./WhiteboardCanvas";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL(
  `${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/excalidraw-assets/`,
  window.location.origin,
).href;

function hostOf(): WhiteboardFrameHost | null {
  try {
    return (window.frameElement as WhiteboardFrameElement | null)?.[WHITEBOARD_HOST_PROPERTY] ?? null;
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
  createRoot(document.getElementById("whiteboard")!).render(<WhiteboardCanvas host={host} />);
}

mount();

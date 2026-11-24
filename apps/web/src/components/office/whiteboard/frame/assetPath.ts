/**
 * Points Excalidraw at the fonts the app ships (`excalidraw-assets/`). It must
 * run before Excalidraw's module does: Excalidraw builds its font URLs when it
 * loads, so the frame's entry imports Excalidraw dynamically after this.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL(
  `${(import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")}/excalidraw-assets/`,
  window.location.origin,
).href;

export {};

/**
 * Excalidraw always lists a CDN copy of each font after the local one. The
 * frame keeps only sources from the app itself (and data URLs), so a font
 * never reaches for the network, even when the local copy fails.
 */
const NativeFontFace = window.FontFace;
const localOnly = (source: string | BufferSource): string | BufferSource => {
  if (typeof source !== "string") return source;
  const kept = source.split(/,\s*(?=url\()/).filter((part) => {
    const url = /^url\(["']?([^"')]+)/.exec(part.trim())?.[1];
    if (url === undefined) return true;
    return (
      url.startsWith("data:") ||
      new URL(url, window.location.href).origin === window.location.origin
    );
  });
  return kept.length > 0 ? kept.join(", ") : source;
};
window.FontFace = class extends NativeFontFace {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    super(family, localOnly(source), descriptors);
  }
} as typeof FontFace;

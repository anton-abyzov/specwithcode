/**
 * The fonts a kit ships, for Typography and the rest of the page: the
 * `@font-face` rules in a system's built preview stylesheet (fonts inlined as
 * data URLs), loaded through the FontFace API while the system is open and
 * removed when it closes. Faces load from their data, never from a URL.
 */
import type { DesignOwnerInput, DesignSystem, EnvironmentId } from "@specweave-studio/contracts";
import { useEffect } from "react";

import { readText, useSystemFilesApi } from "./systemFilesApi";

export interface KitFontFace {
  readonly family: string;
  readonly source: string;
  readonly descriptors: FontFaceDescriptors;
}

const property = (body: string, name: string) => {
  const match = body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? null;
};

/** Faces whose every source is a data URL; anything pointing at the network is left out. */
export function fontFacesIn(css: string): KitFontFace[] {
  const faces: KitFontFace[] = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = match[1] ?? "";
    const family = property(body, "font-family")?.replace(/^["']|["']$/g, "");
    // A data URL holds `;` itself (`data:font/woff2;base64,…`), so src is read url by url.
    const source = body.match(/(?:^|;)\s*src\s*:\s*((?:url\([^)]*\)|[^;])*)/i)?.[1]?.trim() ?? null;
    if (!family || !source) continue;
    const urls = [...source.matchAll(/url\(\s*["']?([^"')]+)/gi)].map((url) => url[1] ?? "");
    if (urls.length === 0 || urls.some((url) => !url.startsWith("data:"))) continue;
    const descriptors: FontFaceDescriptors = { display: "swap" };
    const weight = property(body, "font-weight");
    const style = property(body, "font-style");
    const range = property(body, "unicode-range");
    if (weight) descriptors.weight = weight;
    if (style) descriptors.style = style;
    if (range) descriptors.unicodeRange = range;
    faces.push({ family, source, descriptors });
  }
  return faces;
}

export function useKitFonts({
  environmentId,
  owner,
  system,
}: {
  environmentId: EnvironmentId;
  owner: DesignOwnerInput;
  system: DesignSystem;
}) {
  const api = useSystemFilesApi({ environmentId, owner, systemId: system.id });
  const stylesheet = system.previews?.stylesheetFile;
  const builtAt = system.previews?.builtAt;
  const read = api.read;
  useEffect(() => {
    if (
      stylesheet === undefined ||
      builtAt === undefined ||
      typeof FontFace === "undefined" ||
      !document.fonts
    )
      return;
    let live = true;
    const added: FontFace[] = [];
    void read({ origin: "stored", path: stylesheet }).then((outcome) => {
      if (!live || !outcome.ok) return;
      // A family the app already has (Inter, say) is left alone, so the app never restyles.
      const appFamilies = new Set<string>();
      document.fonts.forEach((font) => appFamilies.add(font.family.replace(/^["']|["']$/g, "")));
      for (const face of fontFacesIn(readText(outcome.value))) {
        if (appFamilies.has(face.family)) continue;
        try {
          const font = new FontFace(face.family, face.source, face.descriptors);
          document.fonts.add(font);
          added.push(font);
          void font.load().catch(() => undefined);
        } catch {
          // A face the browser cannot parse is skipped; the rest still load.
        }
      }
    });
    return () => {
      live = false;
      for (const font of added) document.fonts.delete(font);
    };
  }, [builtAt, read, stylesheet]);
}

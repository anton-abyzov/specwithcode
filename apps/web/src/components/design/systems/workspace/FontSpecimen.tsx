/**
 * A font file shown as a specimen: the face is loaded from its bytes through
 * the FontFace API under a private family name, never from a URL, and is
 * removed from the document when the specimen goes.
 */
import { useEffect, useId, useState } from "react";

const PANGRAM = "The quick brown fox jumps over the lazy dog";
const SIZES = [48, 32, 24, 18, 14, 12] as const;
const ALPHABET = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789 & ! ? @ # % ( ) , . : ;",
];

type FaceState = "loading" | "ready" | "failed" | "unsupported";

export function FontSpecimen({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const id = useId();
  const family = `ds-specimen-${id.replace(/[^A-Za-z0-9]/g, "")}`;
  const [state, setState] = useState<FaceState>(() =>
    typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts
      ? "unsupported"
      : "loading",
  );

  useEffect(() => {
    if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts)
      return;
    const fontSet = document.fonts;
    let live = true;
    let face: FontFace | null = null;
    try {
      // A copy, so the face never holds a view into a buffer someone else reuses.
      face = new FontFace(family, bytes.slice().buffer);
    } catch {
      // oxlint-disable-next-line react/set-state-in-effect -- a face that cannot be built fails at once.
      setState("failed");
      return;
    }
    const loaded = face;
    void loaded.load().then(
      () => {
        if (!live) return;
        fontSet.add(loaded);
        setState("ready");
      },
      () => live && setState("failed"),
    );
    return () => {
      live = false;
      fontSet.delete(loaded);
    };
  }, [bytes, family]);

  if (state === "unsupported" || state === "failed")
    return (
      <p className="m-auto p-6 text-center text-sm text-muted-foreground" role="status">
        {state === "failed"
          ? `${name} could not be loaded as a font, so there is no specimen. Download it to check the file.`
          : "This window can't load fonts for a preview."}
      </p>
    );

  return (
    <div
      className={`flex min-w-0 flex-col gap-5 overflow-hidden px-5 py-6 ${state === "loading" ? "invisible" : ""}`}
      data-testid="font-specimen"
      data-state={state}
      aria-busy={state === "loading"}
    >
      <div style={{ fontFamily: `"${family}", var(--font-sans)` }} className="flex flex-col gap-4">
        {SIZES.map((size) => (
          <div key={size} className="flex min-w-0 flex-col gap-1">
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">{size} px</span>
            <p
              className="break-words text-foreground"
              style={{ fontSize: size, lineHeight: 1.2, fontFamily: "inherit" }}
            >
              {PANGRAM}
            </p>
          </div>
        ))}
      </div>
      <div
        className="flex flex-col gap-1 border-t border-border/60 pt-4 text-xl text-foreground"
        style={{ fontFamily: `"${family}", var(--font-sans)` }}
      >
        {ALPHABET.map((line) => (
          <p key={line} className="break-all">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

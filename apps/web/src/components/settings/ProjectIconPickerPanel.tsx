import * as Schema from "effect/Schema";
import {
  ProjectMonogramText,
  type ProjectIconColor,
  type ProjectIconOverride,
} from "@specweave-studio/contracts";
import { BanIcon, ImageIcon, SearchIcon } from "lucide-react";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { deriveProjectIdentity } from "../../projectIdentity";
import {
  filterProjectEmojis,
  filterProjectIconNames,
  firstEmoji,
  PROJECT_ICON_COLORS,
  projectIconColorClassName,
} from "../../projectIconOptions";
import { ProjectMonogram } from "../ProjectMonogram";

const isMonogramText = Schema.is(ProjectMonogramText);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MONOGRAM_MAX_GRAPHEMES = 2;

type Mode = ProjectIconOverride["kind"];
const MODES: ReadonlyArray<{ readonly value: Mode; readonly label: string }> = [
  { value: "lucide", label: "Icons" },
  { value: "emoji", label: "Emoji" },
  { value: "monogram", label: "Letters" },
];

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeLetters(value: string): string {
  const text = value.normalize("NFKC").trim().toUpperCase();
  return Array.from(graphemes.segment(text), (part) => part.segment)
    .slice(0, MONOGRAM_MAX_GRAPHEMES)
    .join("");
}

/** One string per distinct saved icon, for comparing a pick with what was saved. */
function iconKey(icon: ProjectIconOverride | null): string {
  if (icon === null) return "automatic";
  switch (icon.kind) {
    case "lucide":
      return JSON.stringify([icon.kind, icon.name, icon.color]);
    case "emoji":
      return JSON.stringify([icon.kind, icon.emoji]);
    case "monogram":
      return JSON.stringify([icon.kind, icon.text, icon.color]);
  }
}

const cellClassName =
  "flex aspect-square items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/**
 * The project icon picker's contents. Every choice saves right away through
 * `onSelect`; there is no draft and no Save button.
 */
export function ProjectIconPickerPanel({
  current,
  customized,
  projectName,
  disabled = false,
  onSelect,
  onReset,
  onChooseImage,
}: {
  readonly current: ProjectIconOverride | null;
  /** Whether the project has any icon or image of its own to reset. */
  readonly customized: boolean;
  readonly projectName: string;
  readonly disabled?: boolean;
  /** May return the save: it settles once every queued pick ran, false if the latest failed. */
  readonly onSelect: (icon: ProjectIconOverride) => void | Promise<unknown>;
  readonly onReset: () => void | Promise<unknown>;
  readonly onChooseImage?: (() => void) | undefined;
}) {
  const automatic = deriveProjectIdentity(projectName);
  const savedColor = current && current.kind !== "emoji" ? current.color : automatic.color;
  const savedLetters = current?.kind === "monogram" ? current.text : automatic.monogram;
  const [mode, setMode] = useState<Mode>(current?.kind ?? "lucide");
  const [color, setColor] = useState<ProjectIconColor>(savedColor);
  const [letters, setLetters] = useState(savedLetters);
  const [query, setQuery] = useState("");
  const [lettersEdited, setLettersEdited] = useState(false);
  /** A color chosen here that no save carried yet (as on an emoji, or with invalid letters). */
  const [colorEdited, setColorEdited] = useState(false);

  // The latest pick, until it lands. Earlier picks can land while it is queued:
  // they must not pull the controls back, and the next pick builds on this one,
  // not on the saved icon, so a quick second change never resurrects the first.
  const [expected, setExpected] = useState<{
    readonly icon: ProjectIconOverride | null;
    readonly sequence: number;
    /** The saved icon changed after this pick was sent. */
    readonly changed: boolean;
    /** Every save up to and including this pick has finished. */
    readonly settled: boolean;
    /** The latest save did not go through; the saved icon is what stands. */
    readonly failed: boolean;
  } | null>(null);
  const [sequence, setSequence] = useState(0);
  const send = (icon: ProjectIconOverride | null) => {
    // An emoji carries no color, so a color chosen beside it is still unsent.
    if (icon === null || icon.kind !== "emoji") setColorEdited(false);
    const next = sequence + 1;
    setSequence(next);
    setExpected({ icon, sequence: next, changed: false, settled: false, failed: false });
    const settle = (failed: boolean) =>
      setExpected((value) =>
        value?.sequence === next
          ? { ...value, settled: true, failed: value.failed || failed }
          : value,
      );
    void Promise.resolve(icon ? onSelect(icon) : onReset()).then(
      (saved) => settle(saved === false),
      () => settle(true),
    );
  };
  /** What the next pick changes: the latest pick while it is in flight, else the saved icon. */
  const base = expected ? expected.icon : current;

  // A save, a reset or another window can change the icon while this is open.
  const savedKey = iconKey(current);
  const [synced, setSynced] = useState(savedKey);
  /** The saved icon the controls last showed. */
  const [shown, setShown] = useState(savedKey);
  let pending = expected;
  if (synced !== savedKey) {
    setSynced(savedKey);
    if (pending !== null && !pending.changed) {
      pending = { ...pending, changed: true };
      setExpected(pending);
    }
  }
  // Landed: the saved icon is exactly the latest pick, reached by a save (not an
  // earlier state that happens to look the same) or with every save finished. The
  // controls take the saved icon's color and letters, except letters typed since the
  // pick; a failed save hands everything back to the saved icon.
  let shownKey = shown;
  if (
    pending !== null &&
    (pending.failed || ((pending.changed || pending.settled) && iconKey(pending.icon) === savedKey))
  ) {
    if (pending.failed) {
      shownKey = "";
    } else {
      shownKey = savedKey;
      setShown(savedKey);
      if (!colorEdited) setColor(savedColor);
      if (!lettersEdited) setLetters(savedLetters);
    }
    pending = null;
    setExpected(null);
  }
  if (pending === null && shownKey !== savedKey) {
    setShown(savedKey);
    setColor(savedColor);
    setColorEdited(false);
    setLetters(savedLetters);
    setLettersEdited(false);
  }

  const icons = useMemo(
    () => (mode === "lucide" ? filterProjectIconNames(query) : []),
    [mode, query],
  );
  const emojis = useMemo(() => (mode === "emoji" ? filterProjectEmojis(query) : []), [mode, query]);
  const typedEmoji = mode === "emoji" ? firstEmoji(query) : null;
  const monogram = normalizeLetters(letters);
  const validMonogram = isMonogramText(monogram);

  const saveLetters = (nextColor: ProjectIconColor) => {
    if (!validMonogram) return;
    setLettersEdited(false);
    if (base?.kind === "monogram" && base.text === monogram && base.color === nextColor) return;
    send({ kind: "monogram", text: monogram, color: nextColor });
  };

  const pickColor = (next: ProjectIconColor) => {
    setColor(next);
    setColorEdited(true); // Cleared again below when this color is sent.
    if (mode === "monogram") {
      saveLetters(next);
    } else if (base?.kind === "lucide") {
      if (base.color !== next) send({ ...base, color: next });
    } else if (base?.kind === "monogram") {
      if (base.color !== next) send({ ...base, color: next });
    } else if (base === null && (expected !== null || !customized)) {
      // The automatic icon (also what a reset leaves) is a monogram, so a color alone recolors it.
      send({ kind: "monogram", text: automatic.monogram, color: next });
    }
  };

  const selectedClass = "bg-accent ring-1 ring-foreground/20";

  return (
    <div className="flex w-full flex-col gap-2" data-testid="project-icon-picker">
      {mode === "monogram" ? (
        <div className="flex items-center gap-2">
          <ProjectMonogram
            text={validMonogram ? monogram : automatic.monogram}
            color={color}
            className="size-8"
          />
          <input
            aria-label="Monogram letters"
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
            value={letters}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!validMonogram}
            placeholder={automatic.monogram}
            onChange={(event) => {
              setLetters(normalizeLetters(event.currentTarget.value));
              setLettersEdited(true);
            }}
            // Tabbing through untouched letters must not replace the icon.
            onBlur={() => {
              if (lettersEdited) saveLetters(color);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveLetters(color);
              }
            }}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {Array.from(graphemes.segment(monogram)).length} / {MONOGRAM_MAX_GRAPHEMES}
          </span>
        </div>
      ) : (
        <label className="relative flex items-center">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute start-2 size-3.5 text-muted-foreground"
          />
          <input
            type="search"
            aria-label={mode === "lucide" ? "Search icons" : "Search or paste an emoji"}
            placeholder={mode === "lucide" ? "Search icons" : "Search or paste an emoji"}
            className="h-7 w-full rounded-md border border-input bg-background ps-7 pe-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={query}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      )}

      {mode === "lucide" ? (
        <div className="-mx-1 h-56 overflow-y-auto px-1" role="group" aria-label="Icons">
          {icons.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">No icons found.</p>
          ) : (
            <div className={cn("grid grid-cols-9 gap-0.5", projectIconColorClassName(color))}>
              {icons.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-label={iconLabel(name)}
                  aria-pressed={current?.kind === "lucide" && current.name === name}
                  disabled={disabled}
                  className={cn(
                    cellClassName,
                    current?.kind === "lucide" && current.name === name && selectedClass,
                  )}
                  onClick={() => send({ kind: "lucide", name: name as IconName, color })}
                >
                  <DynamicIcon name={name} className="size-4" />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : mode === "emoji" ? (
        <div className="-mx-1 h-56 overflow-y-auto px-1" role="group" aria-label="Emoji">
          {emojis.length === 0 && !typedEmoji ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No emoji found. Paste any emoji to use it.
            </p>
          ) : (
            <div className="grid grid-cols-9 gap-0.5">
              {typedEmoji && !emojis.some((option) => option.emoji === typedEmoji) ? (
                <button
                  type="button"
                  aria-label={`Use ${typedEmoji}`}
                  disabled={disabled}
                  aria-pressed={current?.kind === "emoji" && current.emoji === typedEmoji}
                  className={cn(
                    cellClassName,
                    "border border-dashed border-border text-lg",
                    current?.kind === "emoji" && current.emoji === typedEmoji && selectedClass,
                  )}
                  onClick={() => send({ kind: "emoji", emoji: typedEmoji })}
                >
                  {typedEmoji}
                </button>
              ) : null}
              {emojis.map((option) => (
                <button
                  key={option.emoji}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={current?.kind === "emoji" && current.emoji === option.emoji}
                  disabled={disabled}
                  className={cn(
                    cellClassName,
                    "text-lg",
                    current?.kind === "emoji" && current.emoji === option.emoji && selectedClass,
                  )}
                  onClick={() => send({ kind: "emoji", emoji: option.emoji })}
                >
                  {option.emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {mode !== "emoji" ? (
        <div className="grid grid-cols-9 gap-0.5" role="group" aria-label="Icon color">
          {PROJECT_ICON_COLORS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              aria-pressed={color === option.value}
              disabled={disabled}
              className={cn(cellClassName, "rounded-full")}
              onClick={() => pickColor(option.value)}
            >
              <span
                className={cn(
                  "size-4 rounded-full ring-offset-2 ring-offset-popover",
                  option.swatchClassName,
                  color === option.value && "ring-2 ring-foreground/70",
                )}
              />
            </button>
          ))}
        </div>
      ) : null}

      <div className="-mx-1 flex items-center gap-1 border-t border-border/60 px-1 pt-2">
        <div role="tablist" aria-label="Icon type" className="flex items-center gap-0.5">
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={mode === option.value}
              className={cn(
                "h-6 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                mode === option.value && "bg-accent text-foreground",
              )}
              onClick={() => {
                setMode(option.value);
                setQuery("");
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {onChooseImage ? (
          <button
            type="button"
            className="ms-auto flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            disabled={disabled}
            onClick={onChooseImage}
          >
            <ImageIcon aria-hidden className="size-3.5" />
            Image…
          </button>
        ) : null}
      </div>

      <div className="-mx-1 border-t border-border/60 pt-1">
        <button
          type="button"
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md px-2 text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          disabled={disabled || !customized}
          onClick={() => send(null)}
        >
          <BanIcon aria-hidden className="size-4" />
          Reset icon and color
        </button>
      </div>
    </div>
  );
}

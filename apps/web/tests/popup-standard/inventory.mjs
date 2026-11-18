// Lists every popup call site in the web app (menus, popovers, dialogs, alert dialogs,
// sheets, selects, comboboxes, autocompletes, preview cards), the toast variants, and the
// iPhone app's sheets, alerts, menus and popovers. One row per call site with the width
// classes it passes, so each override can be decided on purpose (docs/studio/design-guidelines.md, Popups).
// Usage: node apps/web/tests/popup-standard/inventory.mjs [out.json] [--check-overrides]
//   --check-overrides  exits 1 when a menu, popover or dialog sets a width class that is not
//                      a token and is not listed in EXEMPT below.
import fs from "node:fs/promises";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../../../..");
const webSrc = path.join(repo, "apps/web/src");
const iosSrc = path.join(repo, "apps/ios");

const KINDS = [
  ["MenuPopup", "menu"],
  ["PopoverPopup", "popover"],
  ["DialogPopup", "dialog"],
  ["AlertDialogPopup", "alert dialog"],
  ["SheetPopup", "sheet"],
  ["SelectPopup", "select"],
  ["ComboboxPopup", "combobox"],
  ["AutocompletePopup", "autocomplete"],
  ["PreviewCardPopup", "preview card"],
];

// Call sites whose own width is deliberate: full-window viewers and panels that fill a pane.
// Each entry: path suffix -> reason. Keep reasons short; the report prints them.
export const EXEMPT = {
  "apps/web/src/components/chat/ChatComposer.tsx": "attachment file viewer",
  "apps/web/src/components/studio/ProjectWorkspaceAttachments.tsx": "attachment file viewer",
  "apps/web/src/components/studio/shell/CoordinatorAttachments.tsx": "attachment file viewer",
  "apps/web/src/components/design/systems/DesignSystemReviewDialog.tsx": "design system review workspace",
  "apps/web/src/components/studio/ProjectPlan.tsx": "project plan workspace",
  "apps/web/src/components/studio/ProjectWorkspaceSettings.tsx": "project settings workspace",
  "apps/web/src/components/usage/UsagePriceOverrides.tsx": "wide price table",
};

async function walk(dir, filter) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, filter)));
    else if (filter(full)) out.push(full);
  }
  return out;
}

const isSource = (file) =>
  /\.(tsx|ts)$/.test(file) && !/\.(test|spec|stories)\.tsx?$/.test(file) && !file.includes("/ui/");

/** The JSX opening tag that starts at `index`, up to its closing `>` at brace depth 0. */
function openingTag(text, index) {
  let depth = 0;
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0 && text[i - 1] !== "=") return text.slice(index, i + 1);
  }
  return text.slice(index, index + 400);
}

const WIDTH_CLASS = /(?:^|[\s"'`])((?:[a-z]+:)*(?:min-w|max-w|w)-[^\s"'`]+)/g;
const prop = (tag, name) => {
  const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|\\{\\s*"([^"]*)"\\s*\\})`));
  return match ? (match[1] ?? match[2]) : null;
};

export async function inventory() {
  const rows = [];
  for (const file of await walk(webSrc, isSource)) {
    const text = await fs.readFile(file, "utf8");
    for (const [component, kind] of KINDS) {
      const re = new RegExp(`<${component}\\b`, "g");
      let match;
      while ((match = re.exec(text))) {
        const tag = openingTag(text, match.index);
        const line = text.slice(0, match.index).split("\n").length;
        const rel = path.relative(repo, file);
        const widths = [...tag.matchAll(WIDTH_CLASS)].map((m) => m[1]);
        const exempt =
          kind === "dialog" ? (Object.entries(EXEMPT).find(([suffix]) => rel.endsWith(suffix))?.[1] ?? null) : null;
        rows.push({
          platform: "desktop",
          kind,
          file: rel,
          line,
          surface: rel.replace(/^apps\/web\/src\/(components\/)?/, "").split("/").slice(0, -1).join("/") || "(root)",
          widthToken: prop(tag, "width") ?? prop(tag, "size"),
          widthClasses: widths,
          exempt,
        });
      }
    }
  }

  // Toasts: one component; variants are the `type` values passed to toastManager.add.
  const toastTypes = new Map();
  for (const file of await walk(webSrc, isSource)) {
    const text = await fs.readFile(file, "utf8");
    for (const m of text.matchAll(/toastManager\.add\(\s*\{[^}]*?\btype:\s*"([a-z-]+)"/gs)) {
      toastTypes.set(m[1], (toastTypes.get(m[1]) ?? 0) + 1);
    }
  }
  for (const [type, count] of [...toastTypes].sort((a, b) => b[1] - a[1])) {
    rows.push({ platform: "desktop", kind: "toast", file: "apps/web/src/components/ui/toast.tsx", line: 0, surface: `type ${type}`, callers: count, widthToken: null, widthClasses: [], exempt: null });
  }

  // iPhone (SwiftUI): system presentations and custom overlays.
  const IOS = [
    [/\.sheet\(/g, "sheet"],
    [/\.fullScreenCover\(/g, "full-screen cover"],
    [/\.alert\(/g, "alert"],
    [/\.confirmationDialog\(/g, "confirmation dialog"],
    [/\.popover\(/g, "popover"],
    [/\bMenu\s*\{|\bMenu\(/g, "menu"],
    [/\.contextMenu\b/g, "context menu"],
  ];
  try {
    for (const file of await walk(iosSrc, (f) => f.endsWith(".swift") && !/Tests?\//.test(f))) {
      const text = await fs.readFile(file, "utf8");
      for (const [re, kind] of IOS) {
        for (const m of text.matchAll(re)) {
          rows.push({ platform: "iphone", kind, file: path.relative(repo, file), line: text.slice(0, m.index).split("\n").length, surface: path.basename(file, ".swift"), widthToken: null, widthClasses: [], exempt: null });
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return rows;
}

// The standard's largest width per kind, in rem (docs/studio/design-guidelines.md, Popups).
export const MAX_REM = { menu: 32, popover: 32, dialog: 48, "alert dialog": 32 };
const NAMED_REM = { "3xs": 16, "2xs": 18, xs: 20, sm: 24, md: 28, lg: 32, xl: 36, "2xl": 42, "3xl": 48, "4xl": 56, "5xl": 64, "6xl": 72, "7xl": 80 };
/** A width class's size in rem, or null when it does not fix a size (w-full, min-w-0, w-max). */
export function classRem(cls) {
  const bare = cls.replace(/^(?:[a-z0-9]+:)+/, "");
  const m = bare.match(/^(?:min-w|max-w|w)-(.+)$/);
  if (!m) return null;
  const value = m[1];
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) / 4;
  if (value in NAMED_REM) return NAMED_REM[value];
  const rem = value.match(/^\[(?:min\()?(\d+(?:\.\d+)?)(rem|px)/);
  if (rem) return rem[2] === "px" ? Number(rem[1]) / 16 : Number(rem[1]);
  if (value === "none") return Infinity;
  return null;
}
/** Menus, popovers and dialogs whose own width classes go past the standard's cap. */
export function overrides(rows) {
  return rows.filter(
    (row) =>
      row.kind in MAX_REM &&
      !row.exempt &&
      row.widthClasses.some((c) => (classRem(c) ?? 0) > MAX_REM[row.kind]),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const out = args.find((a) => !a.startsWith("--"));
  const rows = await inventory();
  const counts = {};
  for (const row of rows) counts[`${row.platform} ${row.kind}`] = (counts[`${row.platform} ${row.kind}`] ?? 0) + 1;
  const flagged = overrides(rows);
  if (out) await fs.writeFile(out, JSON.stringify({ counts, rows, overrides: flagged.length }, null, 2));
  console.log(JSON.stringify(counts, null, 1));
  console.log(`width overrides to decide: ${flagged.length}`);
  if (args.includes("--check-overrides")) {
    for (const row of flagged) console.log(`  ${row.file}:${row.line} ${row.kind} ${row.widthClasses.join(" ")}`);
    if (flagged.length) process.exit(1);
  }
}

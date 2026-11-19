# Design guidelines

SpecWithCode has one set of design tokens for the web app and the desktop window that wraps it. They live in `apps/web/src/styles/base.css` (typefaces, type scale, corner scale, shadows) and `apps/web/src/index.css` (colors, per theme). Every stylesheet and component reads those tokens. Nothing defines its own font stack, size, corner or status color.

`apps/web/src/designTokens.guard.test.ts` fails when a stylesheet or component goes around the tokens. Run it with `node ../../node_modules/vite-plus/bin/vp test run src/designTokens.guard.test.ts` from `apps/web`.

## Typefaces

| Token          | Tailwind class | Use it for                                                                                                  |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `--font-sans`  | `font-sans`    | All interface text: labels, buttons, menus, headings, empty states, numbers. It is the default on `body`.   |
| `--font-mono`  | `font-mono`    | Code, commands, paths, hashes, ids, branch names, PR numbers, device codes, key caps.                       |
| `--font-serif` | `font-serif`   | Long-form documents only: a report in its reader, a document's preview page, a design system's cover title. |

- Interface headings are sans. A model name, a provider name, a page title and an empty-state heading are interface text.
- A count, a badge or a stat is sans with `tabular-nums` when digits must line up. Mono is not a style for small labels.
- Settings > Appearance overrides `--font-sans` and `--font-mono` at runtime. A font stack written anywhere else ignores that setting, which is why stacks live only in the token sheet. `appearanceFonts.ts` mirrors the default sans and mono stacks; change both together.

## Type scale

Sizes are in rem, so Settings > Appearance > interface size scales all of them.

| Token            | Class          | Size at 16px | Use it for                                        |
| ---------------- | -------------- | ------------ | ------------------------------------------------- |
| `--text-3xs`     | `text-3xs`     | 10px         | Tiny counters and overlays. Avoid for sentences.  |
| `--text-2xs`     | `text-2xs`     | 11px         | Badges, chips, metadata, keyboard hints.          |
| `--text-xs`      | `text-xs`      | 12px         | Secondary text, hints, table cells.               |
| `--text-compact` | `text-compact` | 13px         | Dense rows: sidebars, panes, lists, thread cards. |
| `--text-sm`      | `text-sm`      | 14px         | Body text in controls, menus and dialogs.         |
| `--text-base`    | `text-base`    | 16px         | Chat prose, small titles.                         |
| `--text-lg`      | `text-lg`      | 18px         | Section and empty-state titles.                   |
| `--text-xl`      | `text-xl`      | 20px         | Dialog and sheet titles.                          |
| `--text-2xl`     | `text-2xl`     | 24px         | Page headings.                                    |
| `--text-3xl`     | `text-3xl`     | 30px         | Large stats.                                      |
| `--text-4xl`     | `text-4xl`     | 36px         | Hero numbers.                                     |

- In CSS write `font-size: var(--text-compact)`. In components write `text-compact`. Never `12.5px`, `text-[13px]` or a rem literal.
- `text-4xs` (8px) and `text-5xs` (7px) exist only for provider icon overlays.
- Weights are 400, 500 and 600 (`font-normal`, `font-medium`, `font-semibold`). Titles and names are 600, controls and emphasis 500.
- A `clamp()` is allowed for a masthead that grows with the window, listed in the guard's exceptions.

Exceptions the guard knows about: the report document's own scale in `index.css`, and artifact thumbnails in `panes.css`, which draw a page at a fraction of its size.

## Corners

| Token             | Class            | macOS | Use it for                            |
| ----------------- | ---------------- | ----- | ------------------------------------- |
| `--radius-sm`     | `rounded-sm`     | 6px   | Chips, small buttons, inputs in rows. |
| `--radius-md`     | `rounded-md`     | 8px   | Buttons, rows, list items.            |
| `--radius-lg`     | `rounded-lg`     | 10px  | Cards, popovers, panels.              |
| `--radius-xl`     | `rounded-xl`     | 14px  | Large cards, the composer.            |
| `--radius-dialog` | `rounded-dialog` | 14px  | Dialogs, sheets, the command palette. |

Every step follows `--radius`, which is smaller on Windows and Linux so corners match the system. A raw `8px` does not follow it. Pills and dots use `9999px` or `50%`. Corners of 4px and under are detail and may stay literal.

## Colors

Colors come from the semantic tokens in `index.css`, which every theme and both light and dark modes redefine.

| Meaning              | Text                      | Fill or dot      |
| -------------------- | ------------------------- | ---------------- |
| Default text         | `text-foreground`         |                  |
| Secondary text       | `text-muted-foreground`   | `bg-muted`       |
| Lines                | `border-border`           |                  |
| Accent, selection    | `text-primary`            | `bg-primary`     |
| Done, healthy        | `text-success-foreground` | `bg-success`     |
| Waiting, caution     | `text-warning-foreground` | `bg-warning`     |
| Failed               | `text-error-foreground`   | `bg-error`       |
| Destructive action   | `text-destructive`        | `bg-destructive` |
| Information, running | `text-info-foreground`    | `bg-info`        |
| New, update, merged  | `text-update-foreground`  | `bg-update`      |

- No raw palette classes (`text-emerald-600`, `bg-amber-500`) and no hex for a status or a tone. A token already switches between light and dark, so no `dark:` pair is needed.
- A wash is the token with alpha: `bg-success/12`, or `color-mix(in oklab, var(--primary) 8%, transparent)` in CSS.
- Do not write a hex fallback in `var()`: `var(--success)`, not `var(--success, #3fa66b)`.
- Literal colors are fine for brand marks and logos, file-type icons, theme preview swatches, chart series, the machine identity hues and scrims.
- The shell's `--shell-waiting`, `--shell-working`, `--shell-done`, `--shell-failed` and `--shell-link` alias the tokens above under a chosen theme. The default palette sets its own warm values for them in `shell.css`, the one place a stylesheet defines status colors. The overview's `--desk-*` names are aliases. Use the tokens in new code.

## Shadows

A floating list (popover, menu, select, combobox) uses `shadow-popup dark:shadow-popup-dark`. The composer uses `--shadow-composer`.

## Popups

Menus, popovers, selects, comboboxes, dialogs, sheets and toasts follow one standard. The primitives in `apps/web/src/components/ui/` apply it by default, so a call site that passes no width already complies.

| Kind | Width | Inset |
| --- | --- | --- |
| Menu (`MenuPopup width`) | sizes to its rows, 10rem minimum; cap `sm` 16rem, `md` 20rem (default), `lg` 24rem, `xl` 32rem | 4px frame, rows `px-2`, 28px rows (40px touch) |
| Popover (`PopoverPopup width`) | `auto` sizes to content up to 32rem; fixed `sm` 16rem, `md` 20rem, `lg` 24rem, `xl` 32rem | 16px, `compact` 12px |
| Select, combobox, autocomplete | the trigger's width; long rows widen it only up to 24rem, never past a trigger that is wider | 4px frame |
| Dialog | `max-w-lg` (32rem) by default; larger only for viewers and workspaces, listed in `EXEMPT` in `apps/web/tests/popup-standard/inventory.mjs`; below 640px a bottom sheet | 24px |
| Toast | 24rem stack | 12px |

- Every popup is also capped at the window width minus 2rem and keeps 8px from the window's edges (`collisionPadding`), flipping or shifting to stay inside and scrolling inside itself when taller than the window.
- Section headers are `MenuGroupLabel`: one style, `text-xs` medium, muted. Separators only between groups.
- Rows in one group either all lead with a 16px icon or none do. Status words trail, muted.
- Helper text is one short line (`MenuHint`, about 60 characters) that wraps inside the cap and never sets the width. Anything longer goes behind an info button on the group's label (`MenuInfoGroup`). It is a menu item, so arrow keys, Enter and a tap reach it, and it shows the text in place without closing the menu. It follows the group's rows in focus order, so a menu still opens on its first real row. Its target is 40 by 32px on phones and touch screens. A hover-only tooltip is never the only place an explanation lives.
- Keyboard: a menu opens with focus on its first real row; arrow keys, Home and End move through it; Escape closes it and returns focus to the trigger, also when the pointer rests on a row. Dialogs keep focus inside and return it on close.
- Light and dark both meet WCAG AA text contrast. Solid destructive buttons use `--destructive-solid`, the error color with its lightness capped, under white text; that passes AA on the built-in and generated palettes, while a very light custom error hue (cyan, mint) can fall just short.

Check a change with the headless fixture: `node node_modules/vite-plus/bin/vp build --config apps/web/tests/popup-standard/vite.config.ts`, then `node apps/web/tests/popup-standard/verify.mjs /absolute/owned/report-dir` (390, 840 and 2000px, light and dark, widths, margins, keyboard and axe). `node apps/web/tests/popup-standard/inventory.mjs --check-overrides` lists every popup call site and fails on a width class past the call site's own token (a menu's `width`, default `md`) or the kind's cap, and on one it cannot size (vw units, CSS variables), unless the call site is listed as exempt.

## Spacing

Use Tailwind's spacing scale (multiples of 4px: `gap-1.5`, `px-2`, `py-1`). Shared insets have names in `base.css`: `--workspace-gutter`, `--sidebar-content-inset`, `--command-content-inset`, `--floating-content-inset`. Layout belongs to the parent, not the component.

## Adding a token

Add it to the `@theme static` block in `base.css` with a comment saying what it is for, add a row to this page, and register a new text size with tailwind-merge in `apps/web/src/lib/utils.ts`. If a value is needed once, it is not a token: use the nearest step.

The marketing site and the mobile apps have their own type and are not covered here.

## UI change checklist

Check chat, Settings, command palette, keybindings and reverse actions. Preserve native plans, approvals, queues, steering and checkpoints. Keep unknown quota/offline/errors explicit. Avoid continuously repainting animations and gratuitous state payloads. Use existing semantic UI variants; layout belongs to the parent. Typefaces, sizes, corners and colors come from the design tokens in docs/studio/design-guidelines.md: interface text is sans (serif is for report documents only), sizes and corners are scale tokens, status colors are semantic tokens. `apps/web/src/designTokens.guard.test.ts` enforces it.

Document changes to user tasks and durable architectural constraints, not copies of types. No publication, remote push or release service is implied by local implementation. Require manual acceptance only when the user or increment acceptance criteria explicitly request it. Record unverified installed/native behavior as a proof limit, not an automatic closure blocker for every UI/auth change.

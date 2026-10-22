import { describe, expect, it } from "vite-plus/test";

import { type SourceText, sourceText } from "./common.ts";
import { type ComponentReader, discoverBarrel, discoverFolder } from "./discoverComponents.ts";
import { loadTypeScript } from "./extractTsTheme.ts";

/**
 * Synthetic files that mirror a component library's layout (a primitives
 * barrel re-exporting sibling files, cva variants, CSF stories, and a
 * re-export from another folder). No real library source is used.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "@acme/kit",
    exports: { "./primitives": { import: "./dist/primitives/index.js" } },
  }),
  "src/primitives/index.ts": `"use client";
export * from "../i18n";
export { cn } from "../lib/cn";
export { Button, ButtonGroup, buttonVariants, type ButtonProps } from "./Button";
export { Dialog as Modal } from "./Dialog";
export * from "./Card";
export { default as Avatar } from "./Avatar";
export type { Theme } from "./types";
`,
  "src/primitives/Button.tsx": `import { cva, type VariantProps } from "class-variance-authority";
export const buttonVariants = cva("btn", {
  variants: {
    variant: { primary: "a", secondary: "b", ghost: "c" },
    size: { sm: "d", md: "e" },
  },
});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner. */
  loading?: boolean;
  label: string;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  return null;
});
export function ButtonGroup({ children }: { children: React.ReactNode }) {
  return null;
}
`,
  "src/primitives/Button.stories.tsx": `const meta = { title: "Primitives/Button", component: Button };
export default meta;
export const Primary = { args: { variant: "primary" } };
export const Sizes = () => null;
`,
  "src/primitives/Dialog.tsx": `export type DialogProps = { open: boolean; onOpenChange?: (open: boolean) => void };
export const Dialog = (props: DialogProps) => null;
`,
  "src/primitives/Card.tsx": `export const CARD_PADDING = 12;
export const Card = memo(function Card() { return null; });
export const CardHeader = () => null;
`,
  "src/primitives/Avatar.tsx": `export default function Avatar() { return null; }
`,
  "src/i18n/index.ts": `export const FootballUIProvider = () => null;
`,
  "src/ui/badge.tsx": `export function Badge() { return null; }
export const badgeVariants = cva("x");
`,
  "src/ui/menu.tsx": `function Menu() { return null; }
function MenuItem() { return null; }
export { Menu, MenuItem };
`,
};

const reader = (files: Record<string, string>): ComponentReader => {
  const texts = new Map<string, SourceText>(
    Object.entries(files).map(([path, text]) => [path, sourceText(path, text)]),
  );
  return {
    read: (path) => texts.get(path) ?? null,
    list: (folder) =>
      Object.keys(files).filter(
        (path) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes("/"),
      ),
  };
};

describe("discoverBarrel", () => {
  it("lists components exported from the barrel's folder with props, variants and stories", async () => {
    const ts = await loadTypeScript();
    const files = reader(FILES);
    const { components } = discoverBarrel(ts, files, files.read("src/primitives/index.ts")!);
    expect(components.map((component) => component.name)).toEqual([
      "Avatar",
      "Button",
      "ButtonGroup",
      "Card",
      "CardHeader",
      "Modal",
    ]);
    const button = components.find((component) => component.name === "Button")!;
    expect(button).toMatchObject({
      id: "react:@acme/kit/primitives#Button",
      framework: "react",
      group: "primitives",
      importPath: "@acme/kit/primitives",
      exportName: "Button",
      variants: ["size=md", "size=sm", "variant=ghost", "variant=primary", "variant=secondary"],
      props: [
        { name: "label", type: "string", optional: false },
        { name: "loading", type: "boolean", optional: true },
      ],
      stories: ["Primary", "Sizes"],
    });
    expect(button.provenance).toMatchObject({
      location: "src/primitives/Button.tsx",
      line: 13,
      extractor: "components@1",
    });
    expect(components.find((component) => component.name === "Modal")!.props).toEqual([
      { name: "onOpenChange", type: "(open: boolean) => void", optional: true },
      { name: "open", type: "boolean", optional: false },
    ]);
  });

  it("is deterministic", async () => {
    const ts = await loadTypeScript();
    const files = reader(FILES);
    const barrel = files.read("src/primitives/index.ts")!;
    expect(JSON.stringify(discoverBarrel(ts, files, barrel))).toBe(
      JSON.stringify(discoverBarrel(ts, files, barrel)),
    );
  });
});

describe("discoverFolder", () => {
  it("lists PascalCase components of a folder without a barrel", async () => {
    const ts = await loadTypeScript();
    const { components } = discoverFolder(ts, reader(FILES), "src/ui");
    expect(components.map((component) => [component.name, component.importPath])).toEqual([
      ["Badge", "@acme/kit/ui/badge"],
      ["Menu", "@acme/kit/ui/menu"],
      ["MenuItem", "@acme/kit/ui/menu"],
    ]);
  });
});

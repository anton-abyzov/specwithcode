/**
 * Components a design system offers, without building or running anything:
 *
 *   - React components exported from a TypeScript barrel (`index.ts`) or a
 *     component folder, with their props interface, cva variants and the
 *     story names of a sibling `*.stories.tsx` (Component Story Format);
 *   - CSS class families (`.wv-btn`, `.wv-btn--primary`, `.wv-btn__icon`)
 *     grouped by block, with modifiers as variants and a static preview.
 *
 * Only files the caller hands in through `read` are opened, so the root
 * boundary stays with the scanner. Same input, same sorted output.
 */
import postcss, { type AtRule } from "postcss";
import type * as TS from "typescript-legacy";

import type { DesignSystemComponent, DesignSystemFinding } from "@specweave-studio/contracts";

import { type SourceText, compareText, finding, provenance, sortComponents } from "./common.ts";

export const COMPONENTS_EXTRACTOR = "components@1";
export const CSS_CLASSES_EXTRACTOR = "css-classes@1";

type TypeScript = typeof TS;

export interface ComponentReader {
  /** Reads a root-relative path, or null when it is missing or outside the root. */
  readonly read: (path: string) => SourceText | null;
  /** Lists root-relative file paths directly inside a root-relative folder. */
  readonly list: (folder: string) => ReadonlyArray<string>;
}

export interface ComponentDiscovery {
  readonly components: ReadonlyArray<DesignSystemComponent>;
  readonly findings: ReadonlyArray<DesignSystemFinding>;
}

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const joinPath = (folder: string, relative: string): string | null => {
  const parts = folder ? folder.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
};

const resolveModule = (
  reader: ComponentReader,
  from: string,
  specifier: string,
): SourceText | null => {
  if (!specifier.startsWith(".")) return null;
  const base = joinPath(dirname(from), specifier.replace(/\.(?:js|jsx|mjs)$/, ""));
  if (base === null) return null;
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
  ]) {
    if (!/\.(?:tsx?|jsx?)$/.test(candidate)) continue;
    const source = reader.read(candidate);
    if (source) return source;
  }
  return null;
};

/** Parsed once per read file: a scan's barrels share the files they import. */
const parsed = new WeakMap<SourceText, TS.SourceFile>();
const parse = (ts: TypeScript, source: SourceText) => {
  let file = parsed.get(source);
  if (file === undefined) {
    file = ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.Latest,
      true,
      source.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(source, file);
  }
  return file;
};

const isPascal = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name) && !/^[A-Z0-9_]+$/.test(name);

const hasExport = (ts: TypeScript, node: TS.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** A declaration that renders: a function, an arrow, or forwardRef/memo of one. */
const componentDeclaration = (
  ts: TypeScript,
  file: TS.SourceFile,
  name: string,
): TS.Node | null => {
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) return statement;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        let initializer = declaration.initializer;
        while (
          initializer &&
          (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))
        ) {
          initializer = initializer.expression;
        }
        if (!initializer) return null;
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          return declaration;
        if (ts.isCallExpression(initializer)) {
          const callee = initializer.expression.getText(file);
          if (/(?:^|\.)(?:forwardRef|memo|lazy)$/.test(callee)) return declaration;
          // Object.assign(Root, { Item }) compound components.
          if (callee === "Object.assign" && initializer.arguments.length > 0) return declaration;
        }
        return null;
      }
    }
  }
  return null;
};

interface PropInfo {
  readonly props: Array<{ name: string; type: string; optional: boolean }>;
  readonly variants: string[];
}

const propsOf = (ts: TypeScript, file: TS.SourceFile, component: string): PropInfo => {
  const props: PropInfo["props"] = [];
  const variants = new Set<string>();
  const propsName = `${component}Props`;
  const collectMembers = (members: TS.NodeArray<TS.TypeElement>) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || member.name === undefined) continue;
      const name = member.name.getText(file).replace(/^["']|["']$/g, "");
      props.push({
        name,
        type: (member.type?.getText(file) ?? "unknown").replace(/\s+/g, " ").slice(0, 1_000),
        optional: member.questionToken !== undefined,
      });
    }
  };
  const variantSources = new Set<string>();
  const noteHeritage = (text: string) => {
    for (const match of text.matchAll(/VariantProps<\s*typeof\s+([A-Za-z0-9_$]+)\s*>/g))
      variantSources.add(match[1]!);
  };
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === propsName) {
      collectMembers(statement.members);
      for (const clause of statement.heritageClauses ?? []) noteHeritage(clause.getText(file));
    } else if (ts.isTypeAliasDeclaration(statement) && statement.name.text === propsName) {
      noteHeritage(statement.type.getText(file));
      const visit = (node: TS.Node) => {
        if (ts.isTypeLiteralNode(node)) collectMembers(node.members);
        else ts.forEachChild(node, visit);
      };
      visit(statement.type);
    }
  }
  // cva(base, { variants: { size: { sm: ..., lg: ... } } })
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !variantSources.has(declaration.name.text))
        continue;
      const call = declaration.initializer;
      if (!call || !ts.isCallExpression(call)) continue;
      const config = call.arguments.find(ts.isObjectLiteralExpression);
      const variantsProperty = config?.properties
        .filter(ts.isPropertyAssignment)
        .find((property) => property.name.getText(file) === "variants");
      if (!variantsProperty || !ts.isObjectLiteralExpression(variantsProperty.initializer))
        continue;
      for (const axis of variantsProperty.initializer.properties.filter(ts.isPropertyAssignment)) {
        if (!ts.isObjectLiteralExpression(axis.initializer)) continue;
        const axisName = axis.name.getText(file).replace(/^["']|["']$/g, "");
        for (const option of axis.initializer.properties) {
          if (option.name)
            variants.add(`${axisName}=${option.name.getText(file).replace(/^["']|["']$/g, "")}`);
        }
      }
    }
  }
  return {
    props: props.sort((left, right) => compareText(left.name, right.name)),
    variants: [...variants].sort(compareText),
  };
};

/** Named CSF exports of `<Name>.stories.tsx` beside the component file. */
const storiesFor = (
  ts: TypeScript,
  reader: ComponentReader,
  componentFile: string,
  component: string,
) => {
  const folder = dirname(componentFile);
  const stem = basename(componentFile).replace(/\.(?:tsx?|jsx?)$/, "");
  const candidates = [`${stem}.stories.tsx`, `${stem}.stories.ts`, `${component}.stories.tsx`];
  for (const candidate of candidates) {
    const source = reader.read(folder ? `${folder}/${candidate}` : candidate);
    if (!source) continue;
    const file = parse(ts, source);
    const names: string[] = [];
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement) && hasExport(ts, statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && isPascal(declaration.name.text))
            names.push(declaration.name.text);
        }
      } else if (
        ts.isFunctionDeclaration(statement) &&
        hasExport(ts, statement) &&
        statement.name
      ) {
        if (
          !(ts.getModifiers(statement) ?? []).some(
            (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
          )
        ) {
          names.push(statement.name.text);
        }
      }
    }
    return names.sort(compareText);
  }
  return [];
};

const componentFrom = (
  ts: TypeScript,
  reader: ComponentReader,
  source: SourceText,
  file: TS.SourceFile,
  name: string,
  group: string,
  importPath: string,
): DesignSystemComponent | null => {
  const declaration = componentDeclaration(ts, file, name);
  if (declaration === null) return null;
  const position = file.getLineAndCharacterOfPosition(declaration.getStart(file));
  const { props, variants } = propsOf(ts, file, name);
  const stories = storiesFor(ts, reader, source.path, name);
  return {
    id: `react:${importPath}#${name}`.slice(0, 200),
    name,
    framework: "react",
    group,
    importPath: importPath.slice(0, 500),
    exportName: name,
    ...(variants.length > 0 ? { variants } : {}),
    ...(props.length > 0 ? { props } : {}),
    ...(stories.length > 0 ? { stories } : {}),
    provenance: provenance(
      source,
      COMPONENTS_EXTRACTOR,
      { line: position.line + 1, column: position.character + 1 },
      `${importPath}#${name}`,
    ),
  };
};

/** The import path consumers use: `<package>/<subpath>` when package.json exports it. */
export const importPathFor = (reader: ComponentReader, folder: string): string => {
  let current = folder;
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = reader.read(current ? `${current}/package.json` : "package.json");
    if (manifest) {
      try {
        const json = JSON.parse(manifest.text) as { name?: unknown; exports?: unknown };
        if (typeof json.name === "string") {
          const relative = folder
            .slice(current.length)
            .replace(/^\//, "")
            .replace(/^src\//, "")
            .replace(/^src$/, "");
          const subpath = relative ? `./${relative}` : ".";
          const exportsMap = json.exports;
          if (exportsMap && typeof exportsMap === "object" && subpath in (exportsMap as object)) {
            return subpath === "." ? json.name : `${json.name}/${relative}`;
          }
          return relative ? `${json.name}/${relative}` : json.name;
        }
      } catch {
        // Not JSON; keep walking up.
      }
    }
    if (!current) break;
    current = dirname(current);
  }
  return folder;
};

/**
 * Components exported from a barrel. Re-exports from outside the barrel's
 * folder (`export * from "../i18n"`) are left out: they belong to their own
 * folder's barrel.
 */
export const discoverBarrel = (
  ts: TypeScript,
  reader: ComponentReader,
  barrel: SourceText,
): ComponentDiscovery => {
  const folder = dirname(barrel.path);
  const group = basename(folder) || "components";
  const importPath = importPathFor(reader, folder);
  const file = parse(ts, barrel);
  const components = new Map<string, DesignSystemComponent>();
  const findings: DesignSystemFinding[] = [];
  const inFolder = (path: string) => folder === "" || path.startsWith(`${folder}/`);
  const parsed = new Map<string, { source: SourceText; file: TS.SourceFile }>();
  const load = (specifier: string) => {
    const source = resolveModule(reader, barrel.path, specifier);
    if (!source || !inFolder(source.path)) return null;
    let entry = parsed.get(source.path);
    if (!entry) {
      entry = { source, file: parse(ts, source) };
      parsed.set(source.path, entry);
    }
    return entry;
  };
  const add = (entry: { source: SourceText; file: TS.SourceFile }, name: string) => {
    if (!isPascal(name) || components.has(name)) return;
    const component = componentFrom(ts, reader, entry.source, entry.file, name, group, importPath);
    if (component) components.set(name, component);
  };
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const entry = load(specifier.text);
    if (!entry) continue;
    const clause = statement.exportClause;
    if (clause === undefined) {
      for (const inner of entry.file.statements) {
        if (!hasExport(ts, inner)) continue;
        if (ts.isFunctionDeclaration(inner) && inner.name) add(entry, inner.name.text);
        if (ts.isVariableStatement(inner)) {
          for (const declaration of inner.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) add(entry, declaration.name.text);
          }
        }
      }
    } else if (ts.isNamedExports(clause)) {
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const local = (element.propertyName ?? element.name).text;
        const exported = element.name.text;
        if (local === "default") {
          if (!isPascal(exported) || components.has(exported)) continue;
          const position = entry.file.getLineAndCharacterOfPosition(0);
          components.set(exported, {
            id: `react:${importPath}#${exported}`.slice(0, 200),
            name: exported,
            framework: "react",
            group,
            importPath,
            exportName: exported,
            provenance: provenance(
              entry.source,
              COMPONENTS_EXTRACTOR,
              { line: position.line + 1, column: 1 },
              `${importPath}#${exported}`,
            ),
          });
          continue;
        }
        if (local !== exported) {
          const component = componentFrom(
            ts,
            reader,
            entry.source,
            entry.file,
            local,
            group,
            importPath,
          );
          if (component && isPascal(exported) && !components.has(exported)) {
            components.set(exported, {
              ...component,
              name: exported,
              exportName: exported,
              id: `react:${importPath}#${exported}`.slice(0, 200),
            });
          }
          continue;
        }
        add(entry, exported);
      }
    }
  }
  // Components declared in the barrel itself.
  for (const statement of file.statements) {
    if (!hasExport(ts, statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name)
      add({ source: barrel, file }, statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add({ source: barrel, file }, declaration.name.text);
      }
    }
  }
  return { components: sortComponents(components.values()), findings };
};

/** Components in a folder without a barrel (a shadcn-style `ui/` folder). */
export const discoverFolder = (
  ts: TypeScript,
  reader: ComponentReader,
  folder: string,
): ComponentDiscovery => {
  const group = basename(folder) || "components";
  const importPath = importPathFor(reader, folder);
  const components = new Map<string, DesignSystemComponent>();
  for (const path of [...reader.list(folder)].sort(compareText)) {
    if (!/\.tsx$/.test(path) || /\.(?:stories|test|spec)\.tsx$/.test(path)) continue;
    const source = reader.read(path);
    if (!source) continue;
    const file = parse(ts, source);
    const modulePath = `${importPath}/${basename(path).replace(/\.tsx$/, "")}`;
    for (const statement of file.statements) {
      const names: string[] = [];
      if (ts.isFunctionDeclaration(statement) && statement.name && hasExport(ts, statement))
        names.push(statement.name.text);
      if (ts.isVariableStatement(statement) && hasExport(ts, statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (
            !element.isTypeOnly &&
            (element.propertyName ?? element.name).text === element.name.text
          ) {
            names.push(element.name.text);
          }
        }
      }
      for (const name of names) {
        if (!isPascal(name) || components.has(name)) continue;
        const component = componentFrom(ts, reader, source, file, name, group, modulePath);
        if (component) components.set(name, component);
      }
    }
  }
  return { components: sortComponents(components.values()), findings: [] };
};

// ---------------------------------------------------------------------------
// CSS class families
// ---------------------------------------------------------------------------

interface Family {
  block: string;
  line: number;
  column: number;
  modifiers: Set<string>;
  elements: Set<string>;
  listItems: boolean;
  links: boolean;
}

const blockOf = (className: string) => className.split("__")[0]!.split("--")[0]!;

const previewTag = (family: Family) => {
  if (/(?:^|-)(?:btn|button)$/.test(family.block)) return "button";
  if (/(?:^|-)link$/.test(family.block)) return "a";
  if (family.listItems) return "ul";
  if (/(?:^|-)(?:chip|badge|tag|pill)$/.test(family.block)) return "span";
  if (/(?:^|-)(?:code|cmd|pre)$/.test(family.block)) return "pre";
  return "div";
};

const escape = (value: string) => value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

const previewHtml = (family: Family, label: string) => {
  const tag = previewTag(family);
  const inner = family.listItems
    ? "<li>First</li><li>Second</li>"
    : family.links
      ? `<a href="#">${escape(label)}</a>`
      : escape(label);
  const extra = tag === "a" ? ' href="#"' : tag === "button" ? ' type="button"' : "";
  const one = (classes: string) => `<${tag} class="${classes}"${extra}>${inner}</${tag}>`;
  const items = [
    one(family.block),
    ...[...family.modifiers]
      .sort(compareText)
      .map((modifier) => one(`${family.block} ${family.block}--${modifier}`)),
  ];
  return items.join("\n").slice(0, 64 * 1024);
};

/**
 * Class families whose block starts with `prefix` (`wv-`). With no prefix,
 * the dominant `<word>-` prefix of the file's classes is used, and families
 * are only reported when one exists, so plain app CSS does not flood the list.
 */
export const discoverCssClasses = (source: SourceText, prefix?: string): ComponentDiscovery => {
  let root;
  try {
    root = postcss.parse(source.text, { from: undefined });
  } catch {
    return {
      components: [],
      findings: [
        finding("parse", "warning", "Could not parse CSS for component classes", source.path),
      ],
    };
  }
  const families = new Map<string, Family>();
  const firstClasses: Array<{ className: string; selector: string; line: number; column: number }> =
    [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test((rule.parent as AtRule).name)) return;
    for (const part of rule.selectors) {
      const match = /\.([A-Za-z_][\w-]*)/.exec(part);
      if (!match) continue;
      const start = rule.source?.start;
      firstClasses.push({
        className: match[1]!,
        selector: part,
        line: start?.line ?? 1,
        column: start?.column ?? 1,
      });
    }
  });
  let effectivePrefix = prefix;
  if (effectivePrefix === undefined) {
    const counts = new Map<string, number>();
    for (const { className } of firstClasses) {
      const head = /^([a-z0-9]+-)/i.exec(className)?.[1];
      if (head) counts.set(head, (counts.get(head) ?? 0) + 1);
    }
    const [best, count] = [...counts].sort(
      (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
    )[0] ?? ["", 0];
    if (count < 5 || count / Math.max(firstClasses.length, 1) < 0.6)
      return { components: [], findings: [] };
    effectivePrefix = best;
  }
  for (const { className, selector, line, column } of firstClasses) {
    if (!className.startsWith(effectivePrefix)) continue;
    const block = blockOf(className);
    const family = families.get(block) ?? {
      block,
      line,
      column,
      modifiers: new Set<string>(),
      elements: new Set<string>(),
      listItems: false,
      links: false,
    };
    for (const match of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      const name = match[1]!;
      if (blockOf(name) !== block) continue;
      const modifier = /--([\w-]+)$/.exec(name)?.[1];
      const element = /__([\w-]+?)(?:--|$)/.exec(name)?.[1];
      if (modifier && !name.includes("__")) family.modifiers.add(modifier);
      if (element) family.elements.add(element);
    }
    if (new RegExp(`\\.${block}\\s*>\\s*li\\b`).test(selector)) family.listItems = true;
    if (new RegExp(`\\.${block}\\s+a\\b`).test(selector)) family.links = true;
    families.set(block, family);
  }
  const components = [...families.values()].map((family): DesignSystemComponent => {
    const label = family.block.slice(effectivePrefix!.length) || family.block;
    return {
      id: `css:.${family.block}`,
      name: label,
      framework: "css-class",
      group: "classes",
      importPath: `.${family.block}`,
      ...(family.modifiers.size > 0 ? { variants: [...family.modifiers].sort(compareText) } : {}),
      ...(family.elements.size > 0
        ? {
            props: [...family.elements]
              .sort(compareText)
              .map((element) => ({ name: `__${element}`, type: "element", optional: true })),
          }
        : {}),
      previewHtml: previewHtml(family, label),
      provenance: provenance(
        source,
        CSS_CLASSES_EXTRACTOR,
        { line: family.line, column: family.column },
        `.${family.block}`,
      ),
    };
  });
  return { components: sortComponents(components), findings: [] };
};

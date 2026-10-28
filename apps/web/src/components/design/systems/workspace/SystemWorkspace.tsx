/**
 * The design system page: the title with its menu, the section column, and
 * one card per section (Overview, Colors, Typography, Spacing, Corner radius,
 * Shadows, the other token families, Components, Assets). Files opens over the
 * cards. The URL hash names the section in view.
 */
import type {
  DesignOwnerInput,
  DesignSystem,
  DesignToken,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { ChevronDownIcon, EyeIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import { WorkspacePageHeader } from "../../../WorkspacePageHeader";
import { AddTokenDialog } from "./AddTokenDialog";
import { AssetsSection } from "./AssetsSection";
import { ColorTable } from "./ColorTable";
import { AddComponentDialog, ComponentsSection } from "./ComponentsSection";
import { useKitFonts } from "./kitFonts";
import { FilesBrowser } from "./FilesBrowser";
import { NameValueTable, type ValueCheck } from "./NameValueTable";
import { OverviewSection } from "./OverviewSection";
import { goToToken } from "./pageActions";
import { ShadowTable } from "./ShadowTable";
import type { SystemEditIntent } from "./systemEditIntents";
import { SystemMenu, type SystemMenuProps } from "./SystemMenu";
import { SystemUsageContext } from "./tokenRows";
import { SectionsMenu, SystemNav } from "./SystemNav";
import {
  buildSections,
  isSectionId,
  sectionHeadingId,
  visibleSections,
  type SectionId,
  type SystemSection,
  type TokenSectionKind,
} from "./systemSections";
import { TypographyTable } from "./TypographyTable";
import { CONFLICT_TEXT } from "./useSystemEdits";
import { FontFilesList, UploadFontButton, useFontUploads, type FontUploads } from "./FontFiles";
import { StarterOffer } from "./StarterOffer";
import type { StarterKind } from "./starterSets";
import { INSET } from "./tokenRows";

/** Empty core sections that offer a starter set. */
const STARTERS: Partial<Record<TokenSectionKind, StarterKind>> = {
  colors: "colors",
  typography: "typography",
  spacing: "spacing",
  radius: "radius",
  shadows: "shadows",
};

export const EMPTY_TEXT: Record<TokenSectionKind | "components", string> = {
  colors: "No colors yet.",
  typography: "No type styles yet.",
  spacing: "No spacing values yet.",
  radius: "No corner radii yet.",
  shadows: "No shadows yet.",
  family: "No tokens yet.",
  components: "No components yet.",
};

const TOKEN_KINDS: ReadonlySet<string> = new Set([
  "colors",
  "typography",
  "spacing",
  "radius",
  "shadows",
  "family",
]);

const isTokenSection = (
  section: SystemSection,
): section is SystemSection & { kind: TokenSectionKind } => TOKEN_KINDS.has(section.kind);

/** Lengths are checked as lengths; anything else in a family only as a plain CSS value. */
export function familyCheck(tokens: readonly DesignToken[]): ValueCheck {
  return tokens.length > 0 && tokens.every((token) => token.type === "dimension")
    ? "length"
    : "plain";
}

type Adding =
  | { readonly kind: "token"; readonly sectionId: SectionId; readonly group: string | null }
  | { readonly kind: "component" };

export interface SystemWorkspaceProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly system: DesignSystem;
  /** Tokens, modes, components and notes may change. */
  readonly canEdit: boolean;
  /** Why the page is read-only, next to the title; null when it is not. */
  readonly readOnlyReason: string | null;
  /** Rename, duplicate, rescan and delete are allowed. */
  readonly canManage: boolean;
  readonly onEdit: (intent: SystemEditIntent) => Promise<boolean>;
  readonly conflict: boolean;
  readonly onReload: () => void;
  readonly usage: number | null;
  /** Files in the system's folder; null while unknown. */
  readonly fileCount: number | null;
  /** Where the system lives, ahead of its name ("EasyChamp / Design systems /"). */
  readonly crumbs?: ReactNode;
  readonly menu: Omit<SystemMenuProps, "system" | "usage" | "canManage" | "onRename" | "onStorage">;
  /** Resolves true once renamed. */
  readonly onRename: (name: string) => Promise<boolean>;
  /** The location hash without "#": the section in view. */
  readonly hash: string;
  readonly onHashChange: (hash: string) => void;
  readonly electron?: boolean;
  /** Files, the README or an import changed the system outside the edit queue. */
  readonly onChanged?: () => void;
}

const GO_TO_ALIASES: Record<string, SectionId> = {
  overview: "readme",
  typography: "type",
  radius: "corners",
};

/**
 * The page section a "Go to" from Files names (`readme`, `type`, `assets`…),
 * or null when this page does not show it.
 */
export function goToSectionId(id: string, shown: readonly SectionId[]): SectionId | null {
  const target = GO_TO_ALIASES[id] ?? id;
  return isSectionId(target) && shown.includes(target) ? target : null;
}

const sectionElement = (id: string) => document.getElementById(`section-${id}`);

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function SystemWorkspace(props: SystemWorkspaceProps) {
  const { system, onHashChange } = props;
  useKitFonts({ environmentId: props.environmentId, owner: props.owner, system });
  const editable = props.canEdit && !props.conflict;
  const fonts = useFontUploads({
    environmentId: props.environmentId,
    owner: props.owner,
    systemId: system.id,
    canEdit: editable,
    ...(props.onChanged === undefined ? {} : { onChanged: props.onChanged }),
  });
  const fontCount = fonts.fonts?.length ?? 0;
  const sections = useMemo(
    () =>
      visibleSections(buildSections(system), {
        canEdit: props.canEdit,
        componentCount: system.components.length,
        fontCount,
      }),
    [fontCount, props.canEdit, system],
  );
  const ids = useMemo(() => sections.map((section) => section.id), [sections]);
  const idsKey = ids.join(" ");
  const fromHash = isSectionId(props.hash) && ids.includes(props.hash) ? props.hash : null;
  const [active, setActive] = useState<SectionId | null>(fromHash ?? ids[0] ?? null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionId>>(() => new Set());
  const [filesOpen, setFilesOpen] = useState(false);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [renaming, setRenaming] = useState(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** The hash this page wrote itself; it does not scroll again. */
  const ownHash = useRef<string | null>(null);
  /** Scroll-spy stays quiet while a jump scrolls past other sections. */
  const quietUntil = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const writeHash = useCallback(
    (id: string) => {
      ownHash.current = id;
      onHashChange(id);
    },
    [onHashChange],
  );

  const scrollToSection = useCallback((id: SectionId, smooth: boolean) => {
    const element = sectionElement(id);
    if (element === null || typeof element.scrollIntoView !== "function") return;
    quietUntil.current = Date.now() + 700;
    element.scrollIntoView({
      block: "start",
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  }, []);

  const expand = useCallback(
    (id: SectionId) =>
      setCollapsed((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      }),
    [],
  );

  const showSection = useCallback(
    (id: SectionId) => {
      setFilesOpen(false);
      setActive(id);
      expand(id);
      writeHash(id);
      // After Files closes and the section opens.
      window.requestAnimationFrame(() => scrollToSection(id, true));
    },
    [expand, scrollToSection, writeHash],
  );

  // A hash from outside (a link, back and forward, first load) scrolls to its section.
  // A section not shown yet (Typography waiting for its font list) is tried again when it appears.
  useEffect(() => {
    if (props.hash === ownHash.current) return;
    if (!isSectionId(props.hash) || !ids.includes(props.hash)) return;
    ownHash.current = props.hash;
    setActive(props.hash);
    scrollToSection(props.hash, false);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs for a new hash only
  }, [props.hash, idsKey]);

  // Scroll-spy: the first section crossing the top third of the column is the one in view.
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id.slice(8), entry.isIntersecting);
        if (Date.now() < quietUntil.current) return;
        const first = ids.find((id) => visible.get(id) === true);
        if (first === undefined || first === activeRef.current) return;
        setActive(first);
        writeHash(first);
      },
      { root, rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );
    for (const id of ids) {
      const element = sectionElement(id);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the ids' text is the dependency
  }, [idsKey, writeHash]);

  const goTo = useCallback(
    (name: string) => {
      const home = sections.find(
        (section) =>
          section.tokens.some((token) => token.name === name) ||
          (section.kind === "components" &&
            system.components.some((component) => component.name === name)),
      );
      if (home !== undefined && collapsed.has(home.id))
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(home.id);
          return next;
        });
      setFilesOpen(false);
      window.requestAnimationFrame(() => goToToken(name, scrollRef.current ?? document));
    },
    [collapsed, sections, system.components],
  );

  const toggle = (id: SectionId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const commitRename = (value: string) => {
    setRenaming(false);
    const name = value.trim();
    if (name === "" || name === system.name) return;
    void props.onRename(name);
  };

  // A family section exists only while it has tokens. If a reload empties it, the open
  // dialog keeps the section it was opened on, so what was typed is not lost.
  const lastAddingSection = useRef<(typeof sections)[number] | undefined>(undefined);
  const foundSection =
    adding?.kind === "token"
      ? sections.find((section) => section.id === adding.sectionId)
      : undefined;
  if (foundSection !== undefined) lastAddingSection.current = foundSection;
  const addingSection =
    adding?.kind === "token"
      ? (foundSection ??
        (lastAddingSection.current?.id === adding.sectionId
          ? lastAddingSection.current
          : undefined))
      : undefined;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background text-foreground"
      data-testid="design-system-page"
    >
      <SystemUsageContext.Provider value={props.usage}>
        <WorkspacePageHeader electron={props.electron ?? false} className="gap-2">
          {props.crumbs}
          <div className="flex min-w-0 items-center gap-0.5">
            {renaming ? (
              <input
                ref={titleInput}
                autoFocus
                aria-label="Design system name"
                defaultValue={system.name}
                maxLength={180}
                className="h-7 w-[min(28ch,50vw)] rounded-md border border-input bg-background px-1.5 font-medium text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/16"
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(event.currentTarget.value);
                  if (event.key === "Escape") setRenaming(false);
                }}
                onBlur={(event) => commitRename(event.currentTarget.value)}
              />
            ) : (
              <h1 className="min-w-0 truncate px-1.5 font-medium text-sm" title={system.name}>
                {system.name}
              </h1>
            )}
            <SystemMenu
              {...props.menu}
              system={system}
              usage={props.usage}
              canManage={props.canManage}
              onRename={() => setRenaming(true)}
              onStorage={() => setFilesOpen(true)}
            />
          </div>
          {props.readOnlyReason !== null ? (
            <span
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 text-muted-foreground text-xs"
              title={props.readOnlyReason}
              data-testid="system-read-only"
            >
              <EyeIcon aria-hidden className="size-3" />
              Read-only
              <span className="sr-only">: {props.readOnlyReason}</span>
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <SectionsMenu
              sections={sections}
              active={active}
              componentCount={system.components.length}
              fileCount={props.fileCount}
              filesOpen={filesOpen}
              onSelect={showSection}
              onOpenFiles={() => setFilesOpen(true)}
            />
          </div>
        </WorkspacePageHeader>
        {props.conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-warning/30 border-y bg-warning/8 px-4 py-2 text-sm text-warning-foreground"
            data-testid="system-conflict"
          >
            <span className="min-w-0 flex-1">
              {CONFLICT_TEXT} Reload to see the latest version; your last change was not saved.
            </span>
            <Button size="xs" variant="outline" onClick={props.onReload}>
              Reload
            </Button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <SystemNav
            sections={sections}
            active={active}
            componentNames={system.components.map((component) => component.name)}
            fileCount={props.fileCount}
            filesOpen={filesOpen}
            onSelect={showSection}
            onSelectItem={(id, name) => {
              showSection(id);
              window.setTimeout(() => goToToken(name, scrollRef.current ?? document), 350);
            }}
            onOpenFiles={() => setFilesOpen(true)}
          />
          <main className="relative min-h-0 min-w-0 flex-1">
            <div
              ref={scrollRef}
              className="absolute inset-0 overflow-y-auto overscroll-contain"
              data-testid="system-scroll"
            >
              <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-6 px-3 py-4 sm:px-8 sm:py-8">
                {sections.map((section) => (
                  <SectionCard
                    key={section.id}
                    section={section}
                    open={!collapsed.has(section.id)}
                    onToggle={() => toggle(section.id)}
                    count={
                      section.kind === "components"
                        ? system.components.length
                        : isTokenSection(section)
                          ? section.tokens.length
                          : null
                    }
                    actions={
                      section.kind === "typography" ? (
                        // Progress and results show in the section, so it opens first.
                        <UploadFontButton fonts={fonts} onPick={() => expand(section.id)} />
                      ) : null
                    }
                    onAdd={
                      editable && addable(section, system)
                        ? () =>
                            setAdding(
                              section.kind === "components"
                                ? { kind: "component" }
                                : { kind: "token", sectionId: section.id, group: null },
                            )
                        : null
                    }
                  >
                    <SectionBody
                      {...props}
                      section={section}
                      editable={editable}
                      goTo={goTo}
                      fonts={fonts}
                      onAdd={(group) =>
                        setAdding(
                          section.kind === "components"
                            ? { kind: "component" }
                            : { kind: "token", sectionId: section.id, group },
                        )
                      }
                    />
                  </SectionCard>
                ))}
              </div>
              {fonts.input}
            </div>
            {filesOpen ? (
              <FilesBrowser
                environmentId={props.environmentId}
                owner={props.owner}
                system={system}
                canEdit={props.canEdit}
                onGoToSection={(id) => {
                  setFilesOpen(false);
                  const target = goToSectionId(id, ids);
                  if (target !== null) showSection(target);
                }}
                onClose={() => setFilesOpen(false)}
              />
            ) : null}
          </main>
        </div>
        {addingSection !== undefined &&
        isTokenSection(addingSection) &&
        adding?.kind === "token" ? (
          <AddTokenDialog
            section={addingSection}
            system={system}
            initialGroup={adding.group}
            conflict={props.conflict}
            onReload={props.onReload}
            onOpenChange={(open) => !open && setAdding(null)}
            onAdd={(token) => props.onEdit({ kind: "add", token })}
          />
        ) : null}
        {adding?.kind === "component" ? (
          <AddComponentDialog
            system={system}
            conflict={props.conflict}
            onReload={props.onReload}
            onOpenChange={(open) => !open && setAdding(null)}
            onAdd={props.onEdit}
          />
        ) : null}
      </SystemUsageContext.Provider>
    </div>
  );
}

/** A filled section's header carries "+ Add"; an empty one has it in its empty state. */
function addable(section: SystemSection, system: DesignSystem): boolean {
  if (section.kind === "components") return system.components.length > 0;
  return isTokenSection(section) && section.tokens.length > 0;
}

function SectionCard({
  section,
  open,
  count,
  onToggle,
  actions,
  onAdd,
  children,
}: {
  section: SystemSection;
  open: boolean;
  count: number | null;
  onToggle: () => void;
  /** Section tools before "+ Add" (Typography's Upload font). */
  actions?: ReactNode;
  onAdd: (() => void) | null;
  children: ReactNode;
}) {
  const headingId = sectionHeadingId(section.id);
  // Overview opens on its cover, whose name is the heading.
  const cover = section.kind === "overview";
  return (
    <section
      id={`section-${section.id}`}
      aria-labelledby={headingId}
      data-section={section.id}
      className="scroll-mt-4 overflow-clip rounded-2xl border border-border/60 bg-card text-card-foreground"
    >
      {cover ? null : (
        <header
          className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 pt-6 pb-5 sm:pt-8", INSET)}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`section-${section.id}-body`}
            className="group/title -mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onToggle}
          >
            <h2
              id={headingId}
              className="report-document truncate font-[family-name:var(--report-serif)] font-normal text-[2rem] text-foreground leading-[1.15] tracking-[-0.015em] sm:text-[2.5rem]"
            >
              {section.title}
            </h2>
            {count !== null && count > 0 ? (
              <span className="mt-2 shrink-0 text-muted-foreground text-sm tabular-nums">
                {count}
              </span>
            ) : null}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-[120ms] group-hover/title:opacity-100 group-focus-visible/title:opacity-100 motion-reduce:transition-none",
                !open && "-rotate-90 opacity-100",
              )}
            />
          </button>
          {(actions !== null && actions !== undefined) || onAdd !== null ? (
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {actions}
              {onAdd !== null ? (
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`Add to ${section.title}`}
                  data-testid="section-add"
                  onClick={onAdd}
                >
                  <PlusIcon aria-hidden />
                  Add
                </Button>
              ) : null}
            </div>
          ) : null}
        </header>
      )}
      <div id={`section-${section.id}-body`} hidden={!open} className={cover ? undefined : "pb-5"}>
        {open ? children : null}
      </div>
    </section>
  );
}

function SectionBody(
  props: SystemWorkspaceProps & {
    section: SystemSection;
    editable: boolean;
    goTo: (name: string) => void;
    fonts: FontUploads;
    onAdd: (group: string | null) => void;
  },
) {
  const { section, system } = props;
  const table = {
    system,
    canEdit: props.editable,
    onEdit: props.onEdit,
    onGoTo: props.goTo,
  };
  if (section.kind === "overview")
    return (
      <OverviewSection
        environmentId={props.environmentId}
        owner={props.owner}
        system={system}
        canEdit={props.editable}
        onEdit={props.onEdit}
        usage={props.usage}
        onChanged={props.onChanged}
      />
    );
  if (section.kind === "assets")
    return (
      <div className={INSET}>
        <AssetsSection
          environmentId={props.environmentId}
          owner={props.owner}
          systemId={system.id}
          canEdit={props.canEdit}
        />
      </div>
    );
  if (section.kind === "components")
    return system.components.length === 0 ? (
      <Empty {...props} text={EMPTY_TEXT.components} section={section} />
    ) : (
      <ComponentsSection
        environmentId={props.environmentId}
        owner={props.owner}
        system={system}
        canEdit={props.editable}
        onEdit={props.onEdit}
        onChanged={props.onChanged}
      />
    );
  if (!isTokenSection(section)) return null;
  if (section.kind === "typography")
    return (
      <>
        {section.tokens.length === 0 ? (
          <Empty {...props} text={EMPTY_TEXT.typography} section={section} />
        ) : (
          <TypographyTable {...table} tokens={section.tokens} onAdd={props.onAdd} />
        )}
        <FontFilesList fonts={props.fonts} />
      </>
    );
  if (section.tokens.length === 0)
    return <Empty {...props} text={EMPTY_TEXT[section.kind]} section={section} />;
  switch (section.kind) {
    case "colors":
      return <ColorTable {...table} tokens={section.tokens} onAdd={props.onAdd} />;
    case "shadows":
      return <ShadowTable {...table} tokens={section.tokens} />;
    case "spacing":
    case "radius":
      return (
        <NameValueTable
          {...table}
          tokens={section.tokens}
          check="length"
          preview={section.kind}
          split
        />
      );
    case "family":
      return (
        <NameValueTable
          {...table}
          tokens={section.tokens}
          check={familyCheck(section.tokens)}
          split
        />
      );
  }
}

function Empty({
  text,
  section,
  system,
  editable,
  onEdit,
  onAdd,
}: {
  text: string;
  section: SystemSection;
  system: DesignSystem;
  editable: boolean;
  onEdit: (intent: SystemEditIntent) => Promise<boolean>;
  onAdd: (group: string | null) => void;
}) {
  const starter = isTokenSection(section) ? STARTERS[section.kind] : undefined;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 pb-2", INSET)}
      data-testid="section-empty"
    >
      <p className="mr-auto text-muted-foreground text-sm">{text}</p>
      {editable ? (
        <>
          {starter !== undefined ? (
            <StarterOffer kind={starter} sectionId={section.id} system={system} onEdit={onEdit} />
          ) : null}
          <Button
            variant="outline"
            size="xs"
            aria-label={`Add to ${section.title}`}
            onClick={() => onAdd(null)}
          >
            <PlusIcon aria-hidden />
            Add
          </Button>
        </>
      ) : null}
    </div>
  );
}

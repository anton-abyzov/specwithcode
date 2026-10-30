/** The Skills table's per-row menu and the sheet's link buttons. */
import type { ProjectSkillRow } from "@specweave-studio/contracts";
import {
  BadgeCheckIcon,
  CopyIcon,
  EllipsisIcon,
  FileCodeIcon,
  HistoryIcon,
  SendIcon,
  TagIcon,
  Trash2Icon,
} from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  openUrlInExternalBrowser,
  resolveExternalBrowserTargetPreference,
} from "../../browser/externalBrowsers";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { projectSkillLinks } from "./ProjectSkillLinks";

/** Opens a link in the chosen external browser (the desktop app) or a new tab. */
export async function openSkillLink(url: string): Promise<void> {
  const target = await resolveExternalBrowserTargetPreference().catch(() => null);
  await openUrlInExternalBrowser(url, target).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

export type SkillSheetFocus = "version" | "push";

export function ProjectSkillRowMenu({
  row,
  onOpen,
}: {
  row: ProjectSkillRow;
  onOpen: (name: string, focus: SkillSheetFocus) => void;
}) {
  const links = projectSkillLinks(row);
  const { copyToClipboard } = useCopyToClipboard({ timeout: 1500, target: "path" });
  const versioned = links.skillId !== null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            aria-label={`More actions for ${row.name}`}
            data-testid="skill-row-menu"
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={!links.sourceUrl}
          onClick={() => links.sourceUrl && void openSkillLink(links.sourceUrl)}
        >
          <FileCodeIcon />
          Open source
        </MenuItem>
        <MenuItem
          disabled={!links.registryUrl}
          onClick={() => links.registryUrl && void openSkillLink(links.registryUrl)}
        >
          <BadgeCheckIcon />
          Open on verified-skill.com
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!versioned} onClick={() => onOpen(row.name, "version")}>
          <TagIcon />
          Change version…
        </MenuItem>
        <MenuItem
          disabled={!versioned || !row.lock?.version}
          onClick={() => onOpen(row.name, "push")}
        >
          <SendIcon />
          Push to machines…
        </MenuItem>
        <MenuItem
          variant="destructive"
          disabled={!versioned || !row.lock}
          onClick={() => onOpen(row.name, "version")}
        >
          <Trash2Icon />
          Remove…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={row.path === null}
          onClick={() => row.path && copyToClipboard(row.path, undefined)}
        >
          <CopyIcon />
          Copy path
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Source file, registry page and its versions, as three small buttons. */
export function ProjectSkillLinkButtons({ row }: { row: ProjectSkillRow }) {
  const links = projectSkillLinks(row);
  const items = [
    {
      url: links.sourceUrl,
      label: links.sourceIsFile ? "Source file" : "Source repository",
      icon: <FileCodeIcon aria-hidden />,
    },
    { url: links.registryUrl, label: "Registry", icon: <BadgeCheckIcon aria-hidden /> },
    { url: links.versionsUrl, label: "Versions", icon: <HistoryIcon aria-hidden /> },
  ].filter((item): item is typeof item & { url: string } => item.url !== null);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="skill-links">
      {items.map((item) => (
        <Button
          key={item.label}
          size="xs"
          variant="outline"
          render={
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`${item.label}: ${item.url}`}
              onClick={(event) => {
                event.preventDefault();
                void openSkillLink(item.url);
              }}
            />
          }
        >
          {item.icon}
          {item.label}
        </Button>
      ))}
    </div>
  );
}

import type { ModelSelection } from "@specweave-studio/contracts";
import { ChevronDownIcon, ScanEyeIcon } from "lucide-react";

import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { Button } from "../../ui/button";
import { Group, GroupSeparator } from "../../ui/group";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { workerModelFor } from "./useStartPullRequestWorker";

/**
 * "Review with" and the provider it will use, with every other ready provider one press away.
 * The main half starts the review on the project's default; the chevron picks another, so a
 * second opinion from a different model is the same single press.
 */
export function ReviewWithMenu({
  entries,
  defaultModel,
  pending,
  onReview,
}: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  defaultModel: ModelSelection | null;
  pending: boolean;
  onReview: (model: ModelSelection, providerName: string) => void;
}) {
  const defaultEntry =
    entries.find((entry) => entry.instanceId === defaultModel?.instanceId) ?? entries[0] ?? null;
  const primaryModel =
    defaultEntry === null
      ? null
      : defaultModel?.instanceId === defaultEntry.instanceId
        ? defaultModel
        : workerModelFor(defaultEntry);
  if (defaultEntry === null || primaryModel === null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span />}>
          <Button size="xs" variant="outline" disabled>
            <ScanEyeIcon aria-hidden className="size-3.5" />
            Review
          </Button>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Sign in to a provider to start a review.</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Group data-review-with>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => onReview(primaryModel, defaultEntry.displayName)}
            />
          }
        >
          <ProviderInstanceIcon
            driverKind={defaultEntry.driverKind}
            displayName={defaultEntry.displayName}
            accentColor={defaultEntry.accentColor}
            acpRegistryAgentId={defaultEntry.acpRegistryAgentId}
            acpRegistryIconUrl={defaultEntry.acpRegistryIconUrl}
            className="size-3.5"
            iconClassName="size-3.5"
          />
          {pending ? "Starting review..." : `Review with ${defaultEntry.displayName}`}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Starts a worker thread that reads the diff and reports findings. It never pushes.
        </TooltipPopup>
      </Tooltip>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          aria-label="Review with another provider"
          disabled={pending}
          render={<Button size="icon-xs" variant="outline" />}
        >
          <ChevronDownIcon aria-hidden className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-56">
          <MenuGroup>
            <MenuGroupLabel>Review with</MenuGroupLabel>
            {entries.map((entry) => {
              const model =
                entry.instanceId === defaultModel?.instanceId
                  ? defaultModel
                  : workerModelFor(entry);
              if (model === null) return null;
              const modelName =
                entry.models.find((candidate) => candidate.slug === model.model)?.name ??
                model.model;
              return (
                <MenuItem key={entry.instanceId} onClick={() => onReview(model, entry.displayName)}>
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    acpRegistryAgentId={entry.acpRegistryAgentId}
                    acpRegistryIconUrl={entry.acpRegistryIconUrl}
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
                  <span className="max-w-32 truncate text-xs text-muted-foreground">
                    {modelName}
                  </span>
                </MenuItem>
              );
            })}
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </Group>
  );
}

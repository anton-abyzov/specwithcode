import {
  CommandLineOfferFrame,
  CommandLineToolBody,
  type CommandLineToolBodyProps,
  openCommandLineDocs,
  useCommandLineTool,
} from "./CommandLineTool";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export interface CommandLineToolViewProps extends CommandLineToolBodyProps {
  /** "card": Settings > Machines. "offer": the last first-run step. */
  readonly variant: "card" | "offer";
}

export function CommandLineToolView({ variant, ...props }: CommandLineToolViewProps) {
  if (variant === "offer") {
    return (
      <CommandLineOfferFrame>
        <CommandLineToolBody {...props} />
      </CommandLineOfferFrame>
    );
  }
  return (
    <SettingsSection {...searchableSetting("command-line-tool")} data-command-line-card>
      <CommandLineToolBody {...props} />
    </SettingsSection>
  );
}

/** Settings > Machines > Command line: nothing in a browser or an older desktop app. */
export function CommandLineCard() {
  const tool = useCommandLineTool();
  if (!tool.available) return null;
  return (
    <CommandLineToolView
      variant="card"
      state={tool.state}
      pending={tool.pending}
      error={tool.error}
      onAction={tool.run}
      onOpenDocs={openCommandLineDocs}
    />
  );
}

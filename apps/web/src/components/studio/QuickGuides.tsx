import { Tabs } from "@base-ui/react/tabs";
import {
  BookOpenIcon,
  ClipboardCheckIcon,
  FilePenLineIcon,
  FilesIcon,
  FolderOpenIcon,
  KanbanIcon,
  ListChecksIcon,
  MonitorIcon,
  MonitorUpIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react";
import { useState } from "react";

import { useTx } from "../../i18n";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "../ui/dialog";
import { GuidedTourButton } from "./guidedTour/GuidedTourSetting";
import { GUIDED_TOUR_SETTING_DESCRIPTION } from "./guidedTour/guidedTour.logic";

const guides = [
  {
    id: "specweave",
    title: "SpecWeave",
    icon: KanbanIcon,
    steps: [
      {
        icon: ListChecksIcon,
        title: "Plan an increment",
        body: "Open your project's Board and select Set up SpecWeave if needed. Ask the coordinator to plan one feature. The increment records what to build, how to check it, and the tasks.",
      },
      {
        icon: KanbanIcon,
        title: "Follow it on the Board",
        body: "Open the increment card to read its spec and see tasks move as agents work. Check the acceptance criteria to see what has been verified.",
      },
      {
        icon: ClipboardCheckIcon,
        title: "Read the evidence",
        body: "Before shipping, open the finished card and read its test evidence and any review findings.",
      },
    ],
  },
  {
    id: "artifacts",
    title: "Artifacts",
    icon: FilesIcon,
    steps: [
      {
        icon: FilesIcon,
        title: "Create an artifact",
        body: "Artifacts are project outputs such as reports, spreadsheets, documents, and whiteboards. Ask an agent to make one, or use New on the Artifacts shelf.",
      },
      {
        icon: FolderOpenIcon,
        title: "Open it from Artifacts",
        body: "Open the project's Artifacts shelf and select the file. You can also open an artifact from the card an agent shares in a thread.",
      },
      {
        icon: FilePenLineIcon,
        title: "Edit where supported",
        body: "Edit sheets, documents, and whiteboards in their own editors. Use Save when the editor shows it. For a preview-only file, edit the source or ask the agent to revise it.",
      },
    ],
  },
  {
    id: "machines",
    title: "Multiple machines",
    icon: MonitorIcon,
    steps: [
      {
        icon: MonitorUpIcon,
        title: "Join a machine",
        body: "On the new machine, sign in to Connect and choose a machine to join. On the joined machine, enter the code shown on the new one. On the new machine, review access and select Allow.",
      },
      {
        icon: RefreshCwIcon,
        title: "Sync project files",
        body: "In the project's machine menu, choose {sync} to update copies on linked machines, or {add} if the project is missing on the destination. Review the changes before confirming.",
      },
      {
        icon: SendIcon,
        title: "Hand off unfinished work",
        body: "On the source machine, open Hand off with /away. Choose the destination and review the threads before confirming. Follow their progress in the handoff view.",
      },
    ],
  },
] as const;

export function QuickGuides() {
  const tx = useTx();
  const machineMenuLabels = { sync: tx("Sync…"), add: tx("Add to another machine…") };
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger type="button" className="studio-secondary">
        <BookOpenIcon aria-hidden="true" /> {tx("Quick guides")}
      </DialogTrigger>
      <DialogPopup className="max-w-xl gap-0 overflow-y-auto p-0">
        <DialogTitle className="px-5 pt-5 pb-4 pe-12">{tx("Quick guides")}</DialogTitle>
        {/* 1486: the tour points at the real controls; the dialog closes first so its focus trap lets go. */}
        <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
          <GuidedTourButton onStart={() => setOpen(false)} />
          <span className="text-xs text-muted-foreground">
            {tx(GUIDED_TOUR_SETTING_DESCRIPTION)}
          </span>
        </div>
        <Tabs.Root defaultValue="specweave">
          <Tabs.List
            aria-label={tx("Quick guides")}
            className="grid grid-cols-3 gap-1 border-b border-border px-3"
          >
            {guides.map(({ id, title, icon: Icon }) => (
              <Tabs.Tab
                key={id}
                value={id}
                className="flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-t-md border-b-2 border-transparent px-1.5 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-active:border-primary data-active:text-foreground"
              >
                <Icon className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
                <span className="min-w-0 break-words">{tx(title)}</span>
              </Tabs.Tab>
            ))}
          </Tabs.List>
          {guides.map(({ id, steps }) => (
            <Tabs.Panel key={id} value={id} className="p-4 sm:p-5">
              <ol className="flex flex-col gap-2.5">
                {steps.map(({ icon: Icon, title, body }) => (
                  <li
                    key={title}
                    className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:gap-4 sm:p-4"
                  >
                    <div className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">{tx(title)}</h3>
                      <p className="mt-0.5 text-sm leading-relaxed break-words text-muted-foreground">
                        {tx(body, machineMenuLabels)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </Tabs.Panel>
          ))}
        </Tabs.Root>
      </DialogPopup>
    </Dialog>
  );
}

/* Synthetic data only. One page per popup, opened by its trigger, so verify.mjs can measure
   and shoot it at any window size.
   `?case=` machine | machine-linked | menu | submenu | popover | dialog | alert | select | toast
   `?theme=dark`, `?palette=none` for the unthemed tokens. The machine cases render the real OrchestratorSwitcher (the "Runs on"
   menu) at the coordinator's foot: `machine` is two checkouts that were never linked, as on
   the M5 screenshot of November 18, 2026; `machine-linked` a main and two copies. The other
   cases render the shared primitives with the longest content call sites give them. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { CopyPlusIcon, FolderIcon, Link2Icon, Settings2Icon, Trash2Icon } from "lucide-react";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider, toastManager } from "../../src/components/ui/toast";
import { Button } from "../../src/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuHint,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../src/components/ui/menu";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../../src/components/ui/popover";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "../../src/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../src/components/ui/alert-dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../src/components/ui/select";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
// `?palette=none` keeps the unthemed tokens, so contrast is checked on both.
if (params.get("palette") !== "none") applyThemePalette("studio-chat", dark ? "dark" : "light");
const view = params.get("case") ?? "machine";

const LONG =
  "Not linked: these are separate projects for this repository, each with its own coordinator, threads and memory. That does not stop you viewing or messaging any of them.";

const copy = (
  machine: string,
  role: "main" | "copy" | "unlinked",
  canStart = false,
): OrchestratorCopy => ({
  key: `${machine}:p`,
  machine,
  folder: "/w/atlas",
  role: role === "main" ? "coordinator" : role === "copy" ? "workers" : "independent",
  main: role === "main",
  label:
    role === "main"
      ? { text: "Main" }
      : role === "copy"
        ? { text: "Copy · main on {machine}", values: { machine: "m4" } }
        : { text: "not linked" },
  canStart,
});

function MachineMenu({ linked }: { linked: boolean }) {
  const copies = linked
    ? [copy("m4", "main"), copy("m5", "copy"), copy("linux-mini", "copy", true)]
    : [copy("m4", "unlinked"), copy("m1", "unlinked")];
  const [current, setCurrent] = useState("m4:p");
  return (
    <div className="fixture-page" data-at="foot">
      <OrchestratorSwitcher
        identity={{ color: "rose" } as never}
        label="m4"
        connected
        statusDetail=""
        current={current}
        copies={copies}
        unknown={[]}
        savedMachineMissing={false}
        onView={setCurrent}
        onAllowWorkers={() => {}}
        onMigrate={() => {}}
        onCopy={() => {}}
        onLeave={linked ? () => {} : null}
        links={linked ? [] : [{ key: "m1:p", machine: "m1" }]}
        onLink={linked ? null : () => {}}
      />
    </div>
  );
}

function GalleryMenu() {
  return (
    <div className="fixture-page">
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="sm" data-popup-trigger="" />}>
          Project
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>Open in</MenuGroupLabel>
            <MenuHint>{LONG}</MenuHint>
            <MenuItem>
              <FolderIcon aria-hidden />
              Finder
            </MenuItem>
            <MenuItem>
              <CopyPlusIcon aria-hidden />
              Send to another machine…
            </MenuItem>
            <MenuItem>
              <Link2Icon aria-hidden />
              Link linux-mini-workstation-long-name to this project…
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Danger zone</MenuGroupLabel>
            <MenuItem variant="destructive">
              <Trash2Icon aria-hidden />
              Remove project
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem>
            <Settings2Icon aria-hidden />
            Project settings
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function GallerySubmenu() {
  return (
    <div className="fixture-page">
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="sm" data-popup-trigger="" />}>
          Open in
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem>
            <FolderIcon aria-hidden />
            Finder
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger data-submenu-trigger="">
              <CopyPlusIcon aria-hidden />
              Another machine
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem>m4</MenuItem>
              <MenuItem>linux-mini</MenuItem>
            </MenuSubPopup>
          </MenuSub>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function GalleryPopover() {
  return (
    <div className="fixture-page">
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" data-popup-trigger="" />}>
          Details
        </PopoverTrigger>
        <PopoverPopup align="start">
          <PopoverTitle className="text-sm font-medium">Why this machine</PopoverTitle>
          <p className="mt-1 text-muted-foreground text-sm">{LONG}</p>
          <p className="mt-2 text-muted-foreground text-sm">{LONG}</p>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function GalleryDialog() {
  return (
    <div className="fixture-page">
      <Dialog>
        <DialogTrigger render={<Button variant="outline" size="sm" data-popup-trigger="" />}>
          Send
        </DialogTrigger>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Send Atlas to another machine</DialogTitle>
            <DialogDescription>{LONG}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm">{LONG}</p>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button>Send</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function GalleryAlert() {
  const [open, setOpen] = useState(false);
  return (
    <div className="fixture-page">
      <Button variant="outline" size="sm" data-popup-trigger="" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Atlas from m4?</AlertDialogTitle>
            <AlertDialogDescription>{LONG}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button variant="destructive">Remove</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function GallerySelect() {
  const items = [
    "m4",
    "linux-mini",
    "A machine with a very long nickname that someone typed in Settings",
  ];
  return (
    <div className="fixture-page">
      <Select defaultValue="m4">
        <SelectTrigger className="w-40" data-popup-trigger="" aria-label="Machine">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function GalleryToast() {
  return (
    <div className="fixture-page">
      <Button
        variant="outline"
        size="sm"
        data-popup-trigger=""
        onClick={() =>
          toastManager.add({
            type: "success",
            title: "Atlas linked to m1",
            description: LONG,
            timeout: 0,
          })
        }
      >
        Toast
      </Button>
    </div>
  );
}

const CASES: Record<string, () => React.ReactElement> = {
  machine: () => <MachineMenu linked={false} />,
  "machine-linked": () => <MachineMenu linked />,
  menu: GalleryMenu,
  submenu: GallerySubmenu,
  popover: GalleryPopover,
  dialog: GalleryDialog,
  alert: GalleryAlert,
  select: GallerySelect,
  toast: GalleryToast,
};
const Page = CASES[view] ?? CASES.machine!;

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            <Page />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

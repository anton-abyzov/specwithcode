import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { KeptProjectPages } from "../../src/components/studio/KeptProjectPages";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../../src/components/ui/select";
import {
  Combobox,
  ComboboxInput,
  ComboboxPopup,
  ComboboxList,
  ComboboxItem,
} from "../../src/components/ui/combobox";
import { Popover, PopoverTrigger, PopoverPopup } from "../../src/components/ui/popover";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../../src/components/ui/menu";
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipProvider,
} from "../../src/components/ui/tooltip";
import { Dialog, DialogTrigger, DialogPopup } from "../../src/components/ui/dialog";
import { AlertDialog, AlertDialogPopup } from "../../src/components/ui/alert-dialog";
import { Sheet, SheetPopup } from "../../src/components/ui/sheet";
import {
  PreviewCard,
  PreviewCardTrigger,
  PreviewCardPopup,
} from "../../src/components/ui/preview-card";
import "./fixture.css";
const params = new URLSearchParams(location.search);
const kind = params.get("kind") ?? "select";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
function Popup() {
  const shared = { defaultOpen: true };
  if (kind === "select")
    return (
      <Select {...shared}>
        <SelectTrigger aria-label="Choose">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value="one">Popup one</SelectItem>
          <SelectItem value="two">Popup two</SelectItem>
        </SelectPopup>
      </Select>
    );
  if (kind === "combobox")
    return (
      <Combobox {...shared} items={["Popup one", "Popup two"]}>
        <ComboboxInput aria-label="Search" />
        <ComboboxPopup>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  if (kind === "popover")
    return (
      <Popover {...shared}>
        <PopoverTrigger>Popover</PopoverTrigger>
        <PopoverPopup>Popup content</PopoverPopup>
      </Popover>
    );
  if (kind === "menu")
    return (
      <Menu {...shared}>
        <MenuTrigger>Menu</MenuTrigger>
        <MenuPopup>
          <MenuItem>Popup content</MenuItem>
        </MenuPopup>
      </Menu>
    );
  if (kind === "tooltip")
    return (
      <TooltipProvider>
        <Tooltip {...shared}>
          <TooltipTrigger>Tooltip</TooltipTrigger>
          <TooltipPopup>Popup content</TooltipPopup>
        </Tooltip>
      </TooltipProvider>
    );
  if (kind === "dialog")
    return (
      <Dialog {...shared}>
        <DialogTrigger>Dialog</DialogTrigger>
        <DialogPopup aria-label="Fixture dialog">Popup content</DialogPopup>
      </Dialog>
    );
  if (kind === "alert")
    return (
      <AlertDialog {...shared}>
        <AlertDialogPopup aria-label="Fixture alert">Popup content</AlertDialogPopup>
      </AlertDialog>
    );
  if (kind === "sheet")
    return (
      <Sheet {...shared}>
        <SheetPopup aria-label="Fixture sheet">Popup content</SheetPopup>
      </Sheet>
    );
  return (
    <PreviewCard {...shared}>
      <PreviewCardTrigger href="#">Preview</PreviewCardTrigger>
      <PreviewCardPopup>Popup content</PreviewCardPopup>
    </PreviewCard>
  );
}
function Fixture() {
  const [key, setKey] = useState(location.hash === "#two" ? "two" : "one");
  useEffect(() => {
    const change = () => setKey(location.hash === "#two" ? "two" : "one");
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return (
    <main style={{ padding: 32 }}>
      <h1>Popup presentation: {kind}</h1>
      <a href={key === "one" ? "#two" : "#one"}>Switch project</a>
      <KeptProjectPages
        pageKey={key}
        isLive={() => true}
        page={
          <section style={{ paddingTop: 80 }}>
            <h2>Project {key}</h2>
            {key === "one" && <Popup />}
          </section>
        }
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

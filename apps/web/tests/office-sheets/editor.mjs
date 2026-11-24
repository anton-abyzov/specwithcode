// The sheet editor's keys and edits, in headless Chromium against the fixture's
// ?view=edit workbook. Each check runs with Cmd (platform=mac) and with Ctrl
// (platform=other), so both key maps are covered on every OS. Called by
// shoot.mjs; OFFICE_ONLY=editor runs these alone.

/** Every check, by name; each gets a fresh page. */
export function editorChecks({ mod }) {
  // Copy, cut and paste keys are the operating system's own: Chromium on macOS
  // fires its copy event for Cmd+C only, so the Ctrl map is checked with Cmd there
  // and with Ctrl on Windows and Linux.
  const clip = process.platform === "darwin" ? "Meta" : mod;
  const cell = (page, name) => page.locator(`[data-cell="${name}"]`);
  const text = async (page, name) => ((await cell(page, name).textContent()) ?? "").trim();
  const saved = (page) => page.evaluate(() => JSON.parse(window.sheetSaved ?? "null"));
  const address = (page) => page.locator("[data-sheet-address]").inputValue();
  const press = (page, keys) => page.keyboard.press(keys.replaceAll("Mod", mod));
  const pick = async (page, name) => {
    await cell(page, name).click();
  };
  const stable = (value) =>
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
        : entry,
    );
  const expect = (where, actual, wanted) => {
    if (stable(actual) !== stable(wanted)) {
      throw new Error(`${where}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
    }
  };

  return {
    "type replaces, Enter commits and moves down, the total recalculates and saves": async (page) => {
      await pick(page, "B2");
      await page.keyboard.type("12");
      await press(page, "Enter");
      expect("total", await text(page, "B4"), "18");
      expect("moved to", await address(page), "B3");
      expect("saved", (await saved(page)).tabs[0].cells.B2, 12);
    },
    "F2 edits in place and keeps the text": async (page) => {
      await pick(page, "A2");
      await press(page, "F2");
      await page.keyboard.type(" pot");
      await press(page, "Enter");
      expect("A2", await text(page, "A2"), "Tea pot");
    },
    "double-click edits, Esc cancels": async (page) => {
      await cell(page, "A3").dblclick();
      await page.locator("[data-sheet-editor-field]").waitFor();
      await page.keyboard.type("zzz");
      await press(page, "Escape");
      expect("A3", await text(page, "A3"), "Cake");
      expect("editor gone", await page.locator("[data-sheet-editor-field]").count(), 0);
    },
    "Tab and Shift+Tab move right and left, Shift+Enter moves up": async (page) => {
      await pick(page, "A2");
      await press(page, "Tab");
      expect("Tab", await address(page), "B2");
      await press(page, "Shift+Tab");
      expect("Shift+Tab", await address(page), "A2");
      await press(page, "Shift+Enter");
      expect("Shift+Enter", await address(page), "A1");
      await page.keyboard.type("Thing");
      await press(page, "Tab");
      expect("typed then Tab", await address(page), "B1");
      expect("A1", await text(page, "A1"), "Thing");
    },
    "Delete and Backspace clear the selection": async (page) => {
      await pick(page, "A2");
      await press(page, "Delete");
      expect("A2", await text(page, "A2"), "");
      await pick(page, "B2");
      await page.keyboard.down("Shift");
      await press(page, "ArrowDown");
      await page.keyboard.up("Shift");
      await press(page, "Backspace");
      expect("B4", await text(page, "B4"), "0");
    },
    "arrows, Shift+arrows, Cmd/Ctrl+arrows, Home, End, Page Down and select all": async (page) => {
      await pick(page, "A1");
      await press(page, "ArrowRight");
      expect("right", await address(page), "B1");
      await press(page, "ArrowDown");
      expect("down", await address(page), "B2");
      await press(page, "Shift+ArrowDown");
      expect("extend", await address(page), "B2:B3");
      await pick(page, "A1");
      await press(page, "Mod+ArrowDown");
      expect("data edge", await address(page), "A4");
      await press(page, "Mod+Shift+ArrowUp");
      expect("select to edge", await address(page), "A1:A4");
      await pick(page, "B3");
      await press(page, "Home");
      expect("Home", await address(page), "A3");
      await press(page, "End");
      expect("End", await address(page), "B3");
      await press(page, "Mod+Home");
      expect("Cmd/Ctrl+Home", await address(page), "A1");
      await press(page, "Mod+End");
      expect("Cmd/Ctrl+End", await address(page), "B4");
      await press(page, "PageDown");
      const row = Number((await address(page)).replace(/^[A-Z]+/, ""));
      if (row < 10) throw new Error(`Page Down went to row ${row}`);
      await press(page, "PageUp");
      await press(page, "Mod+a");
      if (!(await address(page)).startsWith("A1:")) throw new Error("select all did not start at A1");
    },
    "undo, redo with Shift+Z and with Y": async (page) => {
      await pick(page, "B2");
      await page.keyboard.type("10");
      await press(page, "Enter");
      expect("after edit", await text(page, "B4"), "16");
      await press(page, "Mod+z");
      expect("undo", await text(page, "B4"), "10");
      await press(page, "Mod+Shift+z");
      expect("redo", await text(page, "B4"), "16");
      await press(page, "Mod+z");
      await press(page, "Mod+y");
      expect("redo with Y", await text(page, "B4"), "16");
    },
    "Cmd/Ctrl+B, I and U toggle styles": async (page) => {
      await pick(page, "A2");
      await press(page, "Mod+b");
      await press(page, "Mod+i");
      await press(page, "Mod+u");
      const td = cell(page, "A2");
      expect("bold", await td.getAttribute("data-bold"), "true");
      expect("italic", await td.getAttribute("data-italic"), "true");
      expect("underline", await td.getAttribute("data-underline"), "true");
      await press(page, "Mod+b");
      expect("bold off", await td.getAttribute("data-bold"), null);
    },
    "copy, cut and paste inside the sheet move formulas": async (page) => {
      await pick(page, "B4");
      await page.keyboard.press(`${clip}+c`);
      await pick(page, "C4");
      await page.keyboard.press(`${clip}+v`);
      expect("pasted formula", (await saved(page)).tabs[0].cells.C4, "=SUM(C2:C3)");
      await pick(page, "A2");
      await page.keyboard.press(`${clip}+x`);
      expect("cut cleared", await text(page, "A2"), "");
      await pick(page, "D2");
      await page.keyboard.press(`${clip}+v`);
      expect("pasted", await text(page, "D2"), "Tea");
    },
    "paste from Excel and Google Sheets keeps the grid": async (page) => {
      await pick(page, "D1");
      const pasted = await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData(
          "text/html",
          '<google-sheets-html-origin><table><tr><td>North</td><td>12</td></tr><tr><td>South</td><td>45%</td></tr></table></google-sheets-html-origin>',
        );
        data.setData("text/plain", "North\t12\nSouth\t45%");
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        return true;
      });
      expect("dispatched", pasted, true);
      expect("D1", await text(page, "D1"), "North");
      expect("E2", await text(page, "E2"), "45%");
      expect("selection", await address(page), "D1:E2");
      const copied = await page.evaluate(() => {
        const data = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
        return { text: data.getData("text/plain"), html: data.getData("text/html") };
      });
      expect("copied TSV", copied.text, "North\t12\nSouth\t45%");
      if (!copied.html.includes("<table")) throw new Error("no HTML table on copy");
    },
    "the formula bar edits the cell": async (page) => {
      await pick(page, "B3");
      await page.locator("[data-sheet-formula]").click();
      await page.locator("[data-sheet-formula]").fill("=B2*3");
      await press(page, "Enter");
      expect("B3", await text(page, "B3"), "12");
      expect("B4", await text(page, "B4"), "16");
    },
    "function names complete and a click puts in a reference": async (page) => {
      await pick(page, "C2");
      await page.keyboard.type("=su");
      await page.locator("[data-sheet-suggestions]").waitFor();
      await press(page, "Tab");
      await cell(page, "B2").click();
      await cell(page, "B3").click({ modifiers: ["Shift"] });
      await page.keyboard.type(")");
      expect("typed", await page.locator("[data-sheet-editor-field]").inputValue(), "=SUM(B2:B3)");
      await press(page, "Enter");
      expect("C2", await text(page, "C2"), "10");
    },
    "F4 cycles absolute references": async (page) => {
      await pick(page, "C2");
      await page.keyboard.type("=B2");
      await press(page, "F4");
      expect("F4", await page.locator("[data-sheet-editor-field]").inputValue(), "=$B$2");
      await press(page, "Escape");
    },
    "the formatting bar sets bold, fill, currency, decimals and borders": async (page) => {
      await pick(page, "B2");
      await page.keyboard.down("Shift");
      await press(page, "ArrowDown");
      await page.keyboard.up("Shift");
      await page.locator('[data-sheet-tool="bold"]').click();
      await page.locator('[data-sheet-tool="align-center"]').click();
      await page.locator('[data-sheet-tool="fill"]').click();
      await page.locator('[data-sheet-fill="accent"]').click();
      await page.locator('[data-sheet-tool="number"]').click();
      await page.locator('[data-sheet-number="currency"]').click();
      await page.locator('[data-sheet-tool="decimals-less"]').click();
      await page.locator('[data-sheet-tool="borders"]').click();
      await page.locator('[data-sheet-border="outline"]').click();
      expect("B2 text", await text(page, "B2"), "$4.0");
      const td = cell(page, "B2");
      expect("bold", await td.getAttribute("data-bold"), "true");
      expect("fill", await td.getAttribute("data-fill-tone"), "accent");
      expect("align", await td.getAttribute("data-align"), "center");
      expect("border", await td.getAttribute("data-border-top"), "true");
      const tab = (await saved(page)).tabs[0];
      expect("format", tab.formats["B2:B3"], { kind: "currency", currency: "USD", decimals: 1 });
    },
    "Cmd/Ctrl+Shift+1, 4 and 5 set number formats": async (page) => {
      await pick(page, "B2");
      await press(page, "Mod+Shift+Digit5");
      expect("percent", await text(page, "B2"), "400%");
      await press(page, "Mod+Shift+Digit4");
      expect("currency", await text(page, "B2"), "$4.00");
      await press(page, "Mod+Shift+Digit1");
      expect("number", await text(page, "B2"), "4.00");
    },
    "right-click inserts and deletes rows and columns, references follow": async (page) => {
      await page.locator('[data-row-header="3"]').click({ button: "right" });
      await page.locator('[data-sheet-menu="rowAbove"]').click();
      let file = await saved(page);
      expect("formula grew", file.tabs[0].cells.B5, "=SUM(B2:B4)");
      expect("other tab follows", file.tabs[1].cells.B1, "=Data!B5");
      await page.locator('[data-col-header="A"]').click({ button: "right" });
      await page.locator('[data-sheet-menu="colLeft"]').click();
      file = await saved(page);
      expect("column inserted", file.tabs[0].cells.C5, "=SUM(C2:C4)");
      await page.locator('[data-col-header="A"]').click({ button: "right" });
      await page.locator('[data-sheet-menu="deleteCols"]').click();
      await page.locator('[data-row-header="3"]').click({ button: "right" });
      await page.locator('[data-sheet-menu="deleteRows"]').click();
      file = await saved(page);
      expect("back", file.tabs[0].cells.B4, "=SUM(B2:B3)");
      expect("summary back", file.tabs[1].cells.B1, "=Data!B4");
      expect("total", await text(page, "B4"), "10");
    },
    "tabs add, rename, switch and delete": async (page) => {
      await page.locator("[data-sheet-tab-add]").click();
      expect("added", await page.locator('[data-sheet-tab="Sheet3"]').getAttribute("data-active"), "true");
      await page.locator('[data-sheet-tab="Data"]').dblclick();
      await page.locator("[data-sheet-tab-rename]").fill("Costs");
      await press(page, "Enter");
      expect("renamed reference", (await saved(page)).tabs[2].cells.B1, "=Costs!B4");
      await page.locator('[data-sheet-tab="Sheet3"]').click({ button: "right" });
      await page.locator('[data-sheet-tab-menu="delete"]').click();
      expect("deleted", await page.locator('[data-sheet-tab="Sheet3"]').count(), 0);
      await pick(page, "A1");
      await press(page, "Shift+F11");
      expect("Shift+F11", (await saved(page)).tabs.length, 3);
      await press(page, "Mod+PageUp");
      expect("previous tab", await page.locator('[role="tab"][data-active="true"]').textContent(), "Costs");
    },
    "Cmd/Ctrl+D fills down": async (page) => {
      await pick(page, "C2");
      await page.keyboard.type("=B2*2");
      await press(page, "Enter");
      await pick(page, "C2");
      await press(page, "Shift+ArrowDown");
      await press(page, "Mod+d");
      expect("filled", (await saved(page)).tabs[0].cells.C3, "=B3*2");
    },
    "Export .csv writes the tab's computed values": async (page) => {
      await page.locator("[data-sheet-export-csv]").click();
      await page.waitForFunction(() => window.sheetExport !== undefined);
      const file = await page.evaluate(() => window.sheetExport);
      expect("name", file.name, "editor-check-data.csv");
      expect("csv", Buffer.from(file.base64, "base64").toString("utf8"), "\uFEFFItem,Cost\r\nTea,4\r\nCake,6\r\nTotal,10\r\n");
    },
    "Export .xlsx writes a workbook with formulas and their values": async (page) => {
      await page.locator("[data-sheet-export-xlsx]").click();
      await page.waitForFunction(() => window.sheetExport !== undefined);
      const file = await page.evaluate(() => window.sheetExport);
      expect("name", file.name, "editor-check.xlsx");
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(Buffer.from(file.base64, "base64"));
      const sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
      const sheet2 = await zip.file("xl/worksheets/sheet2.xml").async("string");
      if (!sheet1.includes("<f>SUM(B2:B3)</f><v>10</v>")) throw new Error("no SUM with its value");
      if (!sheet2.includes("<f>Data!B4</f><v>10</v>")) throw new Error("no cross-tab formula");
      if (!(await zip.file("xl/workbook.xml").async("string")).includes('fullCalcOnLoad="1"')) {
        throw new Error("no recalculation on load");
      }
    },
    "Cmd/Ctrl+/ opens the shortcuts list and Esc closes it": async (page) => {
      await pick(page, "A1");
      await press(page, "Mod+Slash");
      await page.locator("[data-sheet-shortcuts]").waitFor();
      const keys = await page.locator("[data-sheet-shortcuts] kbd").allTextContents();
      const wanted = mod === "Meta" ? "⌘Z" : "Ctrl+Z";
      if (!keys.includes(wanted)) throw new Error(`no ${wanted} in the list`);
      await press(page, "Escape");
      expect("closed", await page.locator("[data-sheet-shortcuts]").count(), 0);
    },
  };
}

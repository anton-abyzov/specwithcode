// A fictional workbook for the sheet viewer fixture: a loan schedule, an
// investment case and a revenue table, every figure computed by a formula.
type Cells = Record<string, string | number | boolean>;

const MONTHS = 24;
const FIRST = 11;

function loanTab() {
  const cells: Cells = {
    A1: "Workshop equipment loan",
    A3: "Amount",
    B3: 48000,
    A4: "Annual rate",
    B4: 0.069,
    A5: "Months",
    B5: MONTHS,
    A6: "Monthly payment",
    B6: "=-PMT(B4/12, B5, B3)",
    A7: "Total interest",
    B7: "=-CUMIPMT(B4/12, B5, B3, 1, B5, 0)",
    A8: "Total paid",
    B8: "=B6*B5",
    A10: "Month",
    B10: "Payment",
    C10: "Interest",
    D10: "Principal",
    E10: "Balance",
  };
  for (let month = 1; month <= MONTHS; month += 1) {
    const row = FIRST + month - 1;
    cells[`A${row}`] = month;
    cells[`B${row}`] = "=$B$6";
    cells[`C${row}`] = `=-IPMT($B$4/12, A${row}, $B$5, $B$3)`;
    cells[`D${row}`] = `=-PPMT($B$4/12, A${row}, $B$5, $B$3)`;
    cells[`E${row}`] = month === 1 ? `=B3-D${row}` : `=E${row - 1}-D${row}`;
  }
  const last = FIRST + MONTHS - 1;
  const total = last + 1;
  cells[`A${total}`] = "Total";
  for (const column of ["B", "C", "D"]) {
    cells[`${column}${total}`] = `=SUM(${column}${FIRST}:${column}${last})`;
  }
  return {
    name: "Loan",
    cells,
    formats: {
      B3: { kind: "currency", decimals: 0 },
      B4: { kind: "percent", decimals: 1 },
      B6: { kind: "currency", decimals: 2 },
      B7: { kind: "currency", decimals: 2 },
      B8: { kind: "currency", decimals: 2 },
      [`B${FIRST}:E${total}`]: { kind: "currency", decimals: 2 },
    },
    styles: {
      A1: { heading: true },
      "A3:A8": { tone: "muted" },
      "B6:B8": { bold: true },
      "A10:E10": { bold: true, fill: true },
      "B10:E10": { bold: true, fill: true, align: "right" },
      [`A${total}:E${total}`]: { bold: true, topBorder: true },
    },
    widths: { A: 150, B: 120, C: 110, D: 110, E: 120 },
    charts: [
      {
        id: "balance",
        type: "line",
        title: "The balance reaches zero in month 24",
        labels: `A${FIRST}:A${last}`,
        values: `E${FIRST}:E${last}`,
        at: "G2",
      },
      {
        id: "interest",
        type: "column",
        title: "Interest falls every month as the balance drops",
        labels: `A${FIRST}:A${last}`,
        values: `C${FIRST}:C${last}`,
        at: "G14",
      },
    ],
  };
}

function investmentTab() {
  const flows = [-180000, 38000, 52000, 61000, 66000, 70000];
  const cells: Cells = {
    A1: "Second store: is it worth opening?",
    A3: "Discount rate",
    B3: 0.09,
    A4: "Finance rate",
    B4: 0.07,
    A5: "Reinvestment rate",
    B5: 0.05,
    A7: "Year",
    B7: "Date",
    C7: "Cash flow",
    D7: "Running total",
    A15: "Net present value",
    B15: "=NPV(B3, C9:C13) + C8",
    A16: "Internal rate of return",
    B16: "=IRR(C8:C13)",
    A17: "Modified rate of return",
    B17: "=MIRR(C8:C13, B4, B5)",
    A18: "Net present value, by date",
    B18: "=XNPV(B3, C8:C13, B8:B13)",
    A19: "Rate of return, by date",
    B19: "=XIRR(C8:C13, B8:B13)",
    A20: "Verdict",
    B20: '=IF(B15>0, "Worth opening", "Not worth opening")',
  };
  flows.forEach((flow, year) => {
    const row = 8 + year;
    cells[`A${row}`] = year;
    cells[`B${row}`] = `${2027 + year}-03-01`;
    cells[`C${row}`] = flow;
    cells[`D${row}`] = year === 0 ? `=C${row}` : `=D${row - 1}+C${row}`;
  });
  return {
    name: "Investment",
    cells,
    formats: {
      "B3:B5": { kind: "percent", decimals: 1 },
      "C8:D13": { kind: "currency", decimals: 0, negative: "parens" },
      B15: { kind: "currency", decimals: 0 },
      "B16:B17": { kind: "percent", decimals: 2 },
      B18: { kind: "currency", decimals: 0 },
      B19: { kind: "percent", decimals: 2 },
    },
    styles: {
      A1: { heading: true },
      "A3:A5": { tone: "muted" },
      "A7:D7": { bold: true, fill: true },
      "C7:D7": { bold: true, fill: true, align: "right" },
      "A15:A20": { tone: "muted" },
      "B15:B19": { bold: true, align: "right" },
      B20: { bold: true, tone: "positive", align: "right" },
    },
    widths: { A: 200, B: 150, C: 130, D: 130 },
    charts: [
      {
        id: "flows",
        type: "column",
        title: "Year 0 costs 180K, then every year pays back more",
        labels: "A8:A13",
        values: "C8:C13",
        at: "F2",
      },
      {
        id: "running",
        type: "line",
        title: "The store has paid for itself by year 4",
        labels: "A8:A13",
        values: "D8:D13",
        at: "F14",
      },
    ],
  };
}

function revenueTab() {
  const regions = ["West", "North", "South", "East"];
  const products = ["Bikes", "Service", "Parts", "Clothing", "Rentals"];
  const quarters = ["Q1", "Q2", "Q3", "Q4"];
  const base = [118, 64, 41, 27, 19];
  const reach = [1.32, 1.0, 0.84, 0.71];
  const season = [0.82, 1.08, 1.21, 0.95];
  const cells: Cells = { A1: "Region", B1: "Product", C1: "Quarter", D1: "Revenue" };
  const rowGroups = [];
  let row = 2;
  regions.forEach((region, r) => {
    const start = row;
    products.forEach((product, p) => {
      quarters.forEach((quarter, q) => {
        cells[`A${row}`] = region;
        cells[`B${row}`] = product;
        cells[`C${row}`] = quarter;
        // A fixed wobble, so the table is not a perfect grid of multiples.
        const wobble = 1 + (((r * 7 + p * 5 + q * 3) % 9) - 4) / 50;
        cells[`D${row}`] = Math.round(base[p]! * reach[r]! * season[q]! * wobble * 1000);
        row += 1;
      });
    });
    rowGroups.push({ id: region.toLowerCase(), label: region, startRow: start, endRow: row - 1 });
  });
  const last = row - 1;
  cells[`A${row}`] = "Total";
  cells[`D${row}`] = `=SUM(D2:D${last})`;
  return {
    name: "Revenue",
    cells,
    formats: { [`D2:D${row}`]: { kind: "currency", decimals: 0 } },
    styles: {
      "A1:D1": { bold: true, fill: true },
      D1: { bold: true, fill: true, align: "right" },
      [`A${row}:D${row}`]: { bold: true, topBorder: true },
    },
    chips: [`B2:B${last}`],
    widths: { A: 100, B: 110, C: 90, D: 120 },
    rowGroups,
    charts: [
      {
        id: "by-region",
        type: "bar",
        title: "The West sells the most, in every quarter",
        labels: `A2:A${last}`,
        values: `D2:D${last}`,
        aggregate: "sum",
        sort: "value-desc",
        filterRange: `C2:C${last}`,
        at: "F1",
      },
      {
        id: "by-product",
        type: "donut",
        title: "Bikes are almost half of revenue",
        labels: `B2:B${last}`,
        values: `D2:D${last}`,
        aggregate: "sum",
        filterRange: `A2:A${last}`,
        at: "F9",
      },
      {
        id: "by-quarter",
        type: "column",
        title: "Summer is the strong season",
        labels: `C2:C${last}`,
        values: `D2:D${last}`,
        aggregate: "sum",
        sort: "label-asc",
        filterRange: `B2:B${last}`,
        at: "F19",
      },
    ],
  };
}

/** The demo workbook as `.sheet.json` text. `animate: false` turns chart motion off. */
export function demoWorkbook(options: { readonly animate: boolean }): string {
  const tabs = [loanTab(), investmentTab(), revenueTab()].map((tab) =>
    options.animate
      ? tab
      : { ...tab, charts: tab.charts.map((chart) => ({ ...chart, animate: false })) },
  );
  return JSON.stringify({ v: 1, kind: "sheet", title: "Tidewater Bikes: money plan", tabs });
}

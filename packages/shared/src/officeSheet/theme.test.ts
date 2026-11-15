import { describe, expect, it } from "vite-plus/test";

import { officeThemeVariables, resolveOfficeTheme, safeCssColor } from "./theme.ts";

const system = {
  modes: ["Light", "Dark"],
  tokens: [
    {
      name: "color.background",
      type: "color",
      group: "surface",
      values: { Light: { resolved: "#ffffff" }, Dark: { resolved: "#0b0b0f" } },
    },
    {
      name: "color.foreground",
      type: "color",
      group: "text",
      values: { Light: { resolved: "#111111" }, Dark: { resolved: "#f5f5f5" } },
    },
    {
      name: "color.border",
      type: "color",
      group: "line",
      values: { Light: { resolved: "#e5e5e5" }, Dark: { resolved: "#2a2a33" } },
    },
    {
      name: "color.primary",
      type: "color",
      group: "brand",
      values: { Light: { resolved: "#5b4bff" }, Dark: { resolved: "#8f85ff" } },
    },
    {
      name: "chart.1",
      type: "color",
      group: "chart",
      values: { Light: { resolved: "#2563eb" }, Dark: { resolved: "#60a5fa" } },
    },
    {
      name: "chart.2",
      type: "color",
      group: "chart",
      values: { Light: { resolved: "#ea580c" }, Dark: { resolved: "#fb923c" } },
    },
    {
      name: "chart.evil",
      type: "color",
      group: "chart",
      values: {
        Light: { resolved: "url(https://evil.example/x)" },
        Dark: { resolved: "var(--secret)" },
      },
    },
    {
      name: "font.sans",
      type: "fontFamily",
      group: "type",
      values: { Light: { resolved: "Inter, system-ui" } },
    },
    { name: "space.2", type: "dimension", group: "space", values: { Light: { resolved: "8px" } } },
  ],
};

describe("office theme", () => {
  it("reads the roles of a design system per mode", () => {
    expect(resolveOfficeTheme(system, "light")).toEqual({
      surface: "#ffffff",
      text: "#111111",
      muted: null,
      line: "#e5e5e5",
      accent: "#5b4bff",
      series: ["#2563eb", "#ea580c"],
      fontFamily: "Inter, system-ui",
    });
    const dark = resolveOfficeTheme(system, "dark");
    expect(dark.surface).toBe("#0b0b0f");
    expect(dark.series).toEqual(["#60a5fa", "#fb923c"]);
  });

  it("falls back to the app theme with no system", () => {
    const theme = resolveOfficeTheme(null, "light");
    expect(theme.surface).toBeNull();
    expect(officeThemeVariables(theme)).toEqual({});
  });

  it("emits only variables that resolved and only safe colours", () => {
    expect(officeThemeVariables(resolveOfficeTheme(system, "light"))).toEqual({
      "--office-surface": "#ffffff",
      "--office-text": "#111111",
      "--office-line": "#e5e5e5",
      "--office-accent": "#5b4bff",
      "--office-font": "Inter, system-ui",
      "--office-series-1": "#2563eb",
      "--office-series-2": "#ea580c",
    });
    expect(safeCssColor("oklch(0.7 0.1 250)")).toBe("oklch(0.7 0.1 250)");
    expect(safeCssColor("red; background:url(x)")).toBeNull();
    expect(safeCssColor("expression(alert(1))")).toBeNull();
  });
});

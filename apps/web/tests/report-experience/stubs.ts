export function useAssetUrlState() {
  return {
    _tag: "Success",
    url: "/report.html" + location.search,
    expiresAt: Date.now() + 3600000,
  };
}
export function useAssetUrlRefresh() {
  return async () => "/report.html" + location.search;
}
export function useTheme() {
  return {
    theme: "system",
    resolvedTheme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light",
    themeHalves: null,
  };
}
export function useClientSettings(select: (value: Record<string, string>) => unknown) {
  return select({ fontFamilySans: "system", fontFamilyCode: "system" });
}

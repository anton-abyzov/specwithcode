export const useAtomValue = () => [];
export const primaryServerKeybindingsAtom = {};
export const useClientSettings = (select: (settings: { favorites: never[] }) => unknown) =>
  select({ favorites: [] });
export const usePrimarySettings = (select: (settings: { timestampFormat: string }) => unknown) =>
  select({ timestampFormat: "relative" });
export const useUpdateClientSettings = () => () => {};

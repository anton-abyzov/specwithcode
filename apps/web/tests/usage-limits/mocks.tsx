// Fixture stand-ins for settings, server atoms and history. Fictional accounts only.
import { Atom } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS } from "@specweave-studio/contracts";
import { indexLimitHistory } from "@specweave-studio/shared/usageLimitForecast";
import { fixtureHistory } from "./data";

const settings = { ...DEFAULT_UNIFIED_SETTINGS, timestampFormat: "12-hour" as const };
export const usePrimarySettings = <T,>(select: (value: typeof settings) => T): T =>
  select(settings);
export const useClientSettings = usePrimarySettings;
export const useSettings = usePrimarySettings;
export const primaryServerKeybindingsAtom = Atom.make({ bindings: [], warnings: [] });
export const serverEnvironment = {};
export const environmentPresentations = { presentationsAtom: Atom.make(new Map()) };
export const useAtomCommand = () => async () => ({ _tag: "Failure" });
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set();
export const ensureLocalApi = () => ({ shell: { openExternal: async () => {} } });
export const useUsageLimitHistory = () => indexLimitHistory([fixtureHistory]);
export const MachineLimitBlocks = () => null;
export const useNavigate = () => () => {};
export const Link = (props: { children?: unknown }) => props.children ?? null;

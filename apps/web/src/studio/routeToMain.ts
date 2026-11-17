/**
 * Where a copy's message box sends when its main is on another machine. Kept free of UI
 * imports so the hook (`useRouteToMain`) and tests share one rule.
 *
 * @module routeToMain
 */
import { checkoutKeyEnvironmentId } from "./projectCoordinatorMachine";

/** Where a copy's message goes: main's checkout, split from its `environmentId:projectId` key. */
export function routeTarget(
  mainKey: string | null,
): { readonly environmentId: string; readonly projectId: string } | null {
  if (!mainKey) return null;
  const environmentId = checkoutKeyEnvironmentId(mainKey);
  const projectId = mainKey.slice(environmentId.length + 1);
  return environmentId && projectId ? { environmentId, projectId } : null;
}

/**
 * Whether a copy's message box can route to main: only while main's machine is connected
 * and this window may run work there. Otherwise the box stays off and says where to write.
 */
export function canRouteToMain(input: {
  readonly copyOff: boolean;
  readonly target: { readonly environmentId: string } | null;
  readonly mainConnected: boolean;
  readonly mayOperate: boolean;
}): boolean {
  return input.copyOff && input.target !== null && input.mainConnected && input.mayOperate;
}

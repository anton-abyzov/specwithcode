// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConnectMachineOwnersSync } from "./ConnectMachineOwnersSync";

// Synthetic accounts only: nothing reaches Connect or a real machine.
const A = "user_fixture_a";
const B = "user_fixture_b";

const state = vi.hoisted(() => {
  const sent: Array<string | null> = [];
  // Stable, as the real hook's command is.
  const setAccount = (account: string | null) => {
    sent.push(account);
    return Promise.resolve({ _tag: "Success", value: undefined });
  };
  return { sent, setAccount };
});

vi.mock("../connection/catalog", () => ({ environmentCatalog: { setAccount: {} } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => state.setAccount,
}));

let renderer: ReactTestRenderer | null = null;
async function show(account: string | null | undefined) {
  await act(async () => {
    const element = <ConnectMachineOwnersSync account={account} />;
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}

beforeEach(() => {
  state.sent.length = 0;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("ConnectMachineOwnersSync (1434)", () => {
  it("sends nothing before Connect settles, then each settled account once", async () => {
    await show(undefined);
    expect(state.sent).toEqual([]);

    await show(A);
    await show(A);
    await show(null);
    await show(B);

    expect(state.sent).toEqual([A, null, B]);
  });
});

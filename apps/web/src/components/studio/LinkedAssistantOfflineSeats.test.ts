import { describe, expect, it } from "vite-plus/test";

import {
  LINKED_SEAT_OFFLINE_PHRASE,
  offlineSeatMachines,
  type SeatMachineReach,
} from "./LinkedAssistantOfflineSeats";

// Fictional machines.
const reach = (states: Record<string, Partial<SeatMachineReach>>) => (environmentId: string) => ({
  environmentId,
  known: true,
  state: "connected",
  checking: false,
  down: false,
  ...states[environmentId],
});

describe("offlineSeatMachines (1448 AC-20)", () => {
  const scopes = [
    { environmentId: "studio" },
    { environmentId: "laptop" },
    { environmentId: "tower" },
    { environmentId: "tower" },
  ];

  it("names nothing while every seat's machine answers", () => {
    expect(offlineSeatMachines(scopes, reach({}))).toEqual([]);
  });

  it("names a machine that does not answer, once", () => {
    expect(offlineSeatMachines(scopes, reach({ tower: { state: "offline", down: true } }))).toEqual(
      ["tower"],
    );
  });

  it("names a machine this window never saved", () => {
    expect(
      offlineSeatMachines(scopes, reach({ laptop: { known: false, state: undefined } })),
    ).toEqual(["laptop"]);
  });

  it("stays quiet about a machine that is connecting or still being checked", () => {
    expect(
      offlineSeatMachines(
        scopes,
        reach({
          laptop: { state: "reconnecting", down: false },
          tower: { known: false, state: undefined, checking: true },
        }),
      ),
    ).toEqual([]);
  });

  it("says it in one plain line", () => {
    expect(LINKED_SEAT_OFFLINE_PHRASE).toBe(
      "{machine} is offline: its chats appear when it is back",
    );
  });
});

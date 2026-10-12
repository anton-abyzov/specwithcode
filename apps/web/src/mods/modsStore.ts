import { create } from "zustand";

import { MAX_MOD_COMMANDS, MAX_MOD_PANES, type ModNode } from "./protocol";

export interface ModCommand {
  readonly mod: string;
  readonly name: string;
  readonly description: string;
}

export interface ModPane {
  readonly mod: string;
  readonly id: string;
  readonly title: string;
  readonly tree: ModNode | null;
}

/** Calls into a mod's frame; set by the host for each running mod. */
export interface ModChannel {
  readonly runCommand: (name: string) => void;
  readonly press: (paneId: string, handler: number) => void;
  readonly closePane: (paneId: string) => void;
}

interface ModsState {
  readonly commands: ReadonlyArray<ModCommand>;
  readonly status: Readonly<Record<string, string>>;
  readonly panes: ReadonlyArray<ModPane>;
  readonly errors: Readonly<Record<string, string>>;
  readonly channels: Readonly<Record<string, ModChannel>>;
  readonly attach: (mod: string, channel: ModChannel) => void;
  /** Drops everything a mod contributed, when it stops or reloads. */
  readonly detach: (mod: string) => void;
  readonly addCommand: (command: ModCommand) => void;
  readonly setStatus: (mod: string, text: string | null) => void;
  readonly openPane: (mod: string, id: string, title: string) => void;
  readonly setPaneTree: (mod: string, id: string, tree: ModNode | null) => void;
  readonly closePane: (mod: string, id: string) => void;
  readonly setError: (mod: string, message: string | null) => void;
}

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const useModsStore = create<ModsState>()((set) => ({
  commands: [],
  status: {},
  panes: [],
  errors: {},
  channels: {},
  attach: (mod, channel) =>
    set((state) => ({
      channels: { ...state.channels, [mod]: channel },
      errors: without(state.errors, mod),
    })),
  detach: (mod) =>
    set((state) => ({
      commands: state.commands.filter((command) => command.mod !== mod),
      status: without(state.status, mod),
      panes: state.panes.filter((pane) => pane.mod !== mod),
      channels: without(state.channels, mod),
    })),
  addCommand: (command) =>
    set((state) => {
      const own = state.commands.filter((entry) => entry.mod === command.mod);
      const others = state.commands.filter(
        (entry) => entry.mod !== command.mod || entry.name !== command.name,
      );
      if (own.length >= MAX_MOD_COMMANDS && !own.some((entry) => entry.name === command.name)) {
        return state;
      }
      return { commands: [...others, command] };
    }),
  setStatus: (mod, text) =>
    set((state) => ({
      status: text === null ? without(state.status, mod) : { ...state.status, [mod]: text },
    })),
  openPane: (mod, id, title) =>
    set((state) => {
      const existing = state.panes.find((pane) => pane.mod === mod && pane.id === id);
      if (existing) {
        return {
          panes: state.panes.map((pane) => (pane === existing ? { ...pane, title } : pane)),
        };
      }
      if (state.panes.filter((pane) => pane.mod === mod).length >= MAX_MOD_PANES) return state;
      return { panes: [...state.panes, { mod, id, title, tree: null }] };
    }),
  setPaneTree: (mod, id, tree) =>
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.mod === mod && pane.id === id ? { ...pane, tree } : pane,
      ),
    })),
  closePane: (mod, id) =>
    set((state) => ({
      panes: state.panes.filter((pane) => pane.mod !== mod || pane.id !== id),
    })),
  setError: (mod, message) =>
    set((state) => ({
      errors: message === null ? without(state.errors, mod) : { ...state.errors, [mod]: message },
    })),
}));

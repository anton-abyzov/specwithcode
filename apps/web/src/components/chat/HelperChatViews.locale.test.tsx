// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { setLocalePreference } from "../../i18n";
import { HelperChatBlockersView } from "./HelperChatBlockers";
import { HelperChatBreadcrumbView } from "./HelperChatBreadcrumb";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocalePreference("en");
});

describe("helper chat words in the interface language", () => {
  it("names the asking machine and the blocked helper in German", async () => {
    setLocalePreference("de");
    await act(async () =>
      root.render(
        <>
          <HelperChatBreadcrumbView
            helper={{ projectName: "specweave", fromMachine: "M5" }}
            onOpen={() => {}}
          />
          <HelperChatBreadcrumbView
            helper={{ projectName: undefined, fromMachine: "M5" }}
            onOpen={() => {}}
          />
          <HelperChatBlockersView
            blocked={[
              {
                helper: { environmentId: "win", id: "helper", title: "Push-Prüfung" } as never,
                blocker: "On win: run gh auth login",
              },
            ]}
            onOpen={() => {}}
          />
        </>,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("· auf M5");
    expect(text).toContain("Von M5");
    expect(text).toContain("Push-Prüfung ist blockiert:");
    const origin = container.querySelector("[data-helper-chat-origin]");
    expect(origin?.getAttribute("aria-label")).toBe(
      "specweave auf M5: den Thread öffnen, der darum gebeten hat",
    );
    expect(container.querySelector("[data-helper-chat-blockers]")?.getAttribute("aria-label")).toBe(
      "Helfer auf anderen Rechnern sind blockiert",
    );
  });
});

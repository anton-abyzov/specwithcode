// Synthetic data only: no server, account, provider or store.
import type { AccessRequestItem } from "@specweave-studio/client-runtime/access-request";
import { ThreadId, TurnItemId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { ArrowUpIcon, MicIcon, PlusIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import {
  AccessRequestCardView,
  AccessRequestPrompt,
  type AccessRequestAnswerHandler,
} from "../../src/components/chat/AccessRequestCard";
import { ComputerUsePermissionCard } from "../../src/components/computerUse/ComputerUsePermissions";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

// The macOS permission card reads its status from the desktop bridge.
Object.assign(window, {
  desktopBridge: {
    getComputerUsePermissions: async () => ({ screenRecording: false, accessibility: false }),
    requestComputerUsePermission: async () => ({ screenRecording: false, accessibility: false }),
  },
});

// A 64px Activity Monitor-style tile, drawn for this fixture.
const ACTIVITY_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAD20lEQVR42u2bSW/TQBTH+TgsXbLZjuM0aROnWZqtSwopadU2iCJo6YVF5YYqJNRy4IAE9IgE4sKBS0Go9945sEh8l0cmIsZjj5cZb0njkf5KPJ6/n98vzxNb8ly6FLawOWqpTA4uT0SY5dTva7JeJOCF3/XEr0xGwUhSNg9m+63kpd/z5IcdgGMIw5CAG36m5K9OxcCO0rMy2B0bpN+T5EcJgG0Iw5yAG35LANem40CjmbkC0HqC9Lua/CgCMIUw9gAmIgmgVSY3Dyy+IP0hgBAAoWXzRRgn6QBMRjlgEToYqzdIfwggBKBpUzEeWDQrlyzHRDuyI7/T+CT5BkD6tQfpP/f7n2MHILZb7ic/UGynOLwApuMCsGiuUDbcJ7zvYAD419ep/E7jm8kXAOrkkVLnO+MDIFLJ6AAgDS2ASCIJLMrNV4j93OEiEUCsnbfldxrfSp4DEM+6RAD88+XxAEBKHkn8sm3pj28U/AcQ5URgUb64oOtLbBd1Sau3zfzS73/3Db1P1vh25CkA4aStK3tsHqhkiX7uQQ33Ha2MJgDp+z0lCfQ93paxxLiDOtEvnm7pLhnfAMilKrih/FIdSyD7brPfr+7LfOoSvaQ5I/tqHdw6N7V0AGJ8CliEDqbe5g8aWAKJbqnfj26ClKr4savza8sfu2Qo4tuVZwDEz5vEkxfe3MD7JQnzi6fbhgCE45XRAYDd+p7dUvq5uxV8Huhtq/3YvwYBhucA4oIELCqUa8r3RLuA/3LPlv+PTaexfcm3bcXPP8TnDbQtHLc0VdCyjE8jTwAIL1fx67+ew8ZKP3exB6OBX/uLD8ZrqyBQANxmkajcXkv5rp7oSCcsftzQ7UcJaMtfAUqoArP4WlEBSCTTYKTB3RmNxA/ruuMIT5r4PNDpJfB0DU/yUR3z0MZVC523UU62AfBbJabg/H5NdyyumsPngaMWZL7dxi8bjSf5ouUIAjp/RwBYKsCMPPYv8RV/Ykz1yt+tCqSuAE6cATPxW2Wi5P1VXZ/ZcbRJ4+XfcCW+nfOgBmCk4kKDajwqeyMAfsQPHADfKRKTT/UemQMFwKcywKJStUntIQFIPm76Fh8pUADS+R39bO1j/MABiCdrmvLvBg8AtXJtEfyQfIADkA9vgl+xkQzfEBGkLNAKHZDFp/y39z5Z/E7iDwUApGS34sg/8gCC8hsCSKZngVaV+hKw+IL0m74tetEBWL4rPPYAUBNn5sCuFhrLQDM+SD/VmoGLBoBp1chFAeB4XaCZqs0VsBoTpN+1xZGjCMCTVaKjAMDX1aS1xVZ/6RqrnPrDxcthc9b+Atnwx5vpScPJAAAAAElFTkSuQmCC";

const at = DateTime.makeUnsafe("2026-11-04T15:20:00.000Z");
const card = (
  id: string,
  fields: Pick<AccessRequestItem, "accessTitle" | "reason" | "subjects" | "accessStatus"> &
    Partial<Pick<AccessRequestItem, "accessScope">>,
): AccessRequestItem =>
  ({
    id: TurnItemId.make(`turn-item:access-request:fixture:${id}`),
    threadId: ThreadId.make("thread-fixture"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: fields.accessStatus === "pending" ? "waiting" : "completed",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
    type: "access_request",
    ...fields,
  }) as AccessRequestItem;

const showcase = (status: AccessRequestItem["accessStatus"]) =>
  card(`showcase-${status}`, {
    accessTitle: "Use Notes",
    reason: "Draft the launch post in Notes from the showcase captions.",
    subjects: [{ kind: "app", key: "app:notes", label: "Notes", detail: "" }],
    accessStatus: status,
  });

const apps = (status: AccessRequestItem["accessStatus"], scope?: "thread" | "machine") =>
  card(`apps-${status}-${scope ?? "none"}`, {
    accessTitle: "Use Notes and Activity Monitor",
    reason: "To find which process keeps the M4 fans running and quit it from Activity Monitor.",
    subjects: [
      {
        kind: "app",
        key: "app:notes",
        label: "Notes",
        detail: "See and control its windows",
      },
      {
        kind: "app",
        key: "app:activity monitor",
        label: "Activity Monitor",
        detail: "See and control its windows, including quitting processes",
        icon: { mimeType: "image/png", data: ACTIVITY_ICON },
      },
    ],
    accessStatus: status,
    ...(scope ? { accessScope: scope } : {}),
  });

const device = (status: AccessRequestItem["accessStatus"]) =>
  card(`device-${status}`, {
    accessTitle: "Control M1 iPhone Duo",
    reason: "To install the new build and tap through the pairing screen.",
    subjects: [
      {
        kind: "device",
        key: "device:m1-iphone-duo",
        label: "iPhone Duo",
        detail: "See its screen, tap and type",
        hostLabel: "M1",
        platform: "ios",
      },
    ],
    accessStatus: status,
  });

const folder = (status: AccessRequestItem["accessStatus"]) =>
  card(`folder-${status}`, {
    accessTitle: "Use the release-notes folder",
    reason: "To read last week's notes and draft this week's.",
    subjects: [
      {
        kind: "folder",
        key: "folder:release-notes",
        label: "release-notes",
        detail: "~/Projects/specwithcode/docs/release-notes",
      },
    ],
    accessStatus: status,
  });

// ?fail=1 makes the answers return the server's message, to show the error line.
const onAnswer: AccessRequestAnswerHandler = async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return params.get("fail") === "1" ? "This access request was already answered." : null;
};

/** A static stand-in for the composer, so the card is seen where it sits. */
function FakeComposer() {
  return (
    <div
      aria-hidden
      data-fake-composer
      className="flex h-14 items-center gap-3 rounded-[1.75rem] border border-border/70 bg-card px-2.5 shadow-[0_2px_10px_-4px_rgb(0_0_0/0.12)] dark:border-white/[0.08] dark:bg-[color-mix(in_srgb,var(--background)_93%,white)]"
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-foreground/[0.05] text-foreground">
        <PlusIcon className="size-4.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        Reply to Claude…
      </span>
      <span className="flex size-9 items-center justify-center rounded-full bg-foreground/[0.05] text-foreground">
        <MicIcon className="size-4" />
      </span>
      <span className="flex size-9 items-center justify-center rounded-full bg-primary/40 text-white">
        <ArrowUpIcon className="size-4" />
      </span>
    </div>
  );
}

function ThreadView() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 pt-6 pb-4">
      <div data-case="timeline" className="flex flex-1 flex-col gap-4">
        <div className="ms-auto max-w-[85%] rounded-2xl bg-foreground/[0.06] px-4 py-2.5 text-sm text-foreground">
          Make showcase images of the app for the launch post.
        </div>
        <p className="text-[0.9375rem]/relaxed text-foreground">
          I&apos;ll capture the best parts of the app, then bring you the images and captions to
          approve before anything goes live.
        </p>
        <div data-case="answered" className="flex flex-col gap-0.5">
          <AccessRequestCardView item={apps("allowed", "thread")} visibility="local" />
          <AccessRequestCardView item={apps("allowed", "machine")} visibility="local" />
          <AccessRequestCardView item={device("denied")} visibility="local" />
          <AccessRequestCardView item={device("cancelled")} visibility="local" />
          <AccessRequestCardView item={device("pending")} visibility="inherited" />
          <AccessRequestCardView
            item={showcase("pending")}
            visibility="local"
            agentLabel="Claude"
          />
        </div>
      </div>
      <div className="sticky bottom-0 flex flex-col gap-3 pt-4">
        <div data-case="pending-apps">
          <AccessRequestPrompt item={showcase("pending")} agentLabel="Claude" onAnswer={onAnswer} />
        </div>
        <FakeComposer />
      </div>
    </div>
  );
}

function Gallery() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4">
      <section data-case="pending-two-apps">
        <AccessRequestPrompt item={apps("pending")} agentLabel="Codex" onAnswer={onAnswer} />
      </section>
      <section data-case="pending-device">
        <AccessRequestPrompt item={device("pending")} agentLabel={null} onAnswer={onAnswer} />
      </section>
      <section data-case="pending-folder">
        <AccessRequestPrompt item={folder("pending")} agentLabel="Codex" onAnswer={onAnswer} />
      </section>
      <section data-case="read-only">
        <AccessRequestPrompt
          item={device("pending")}
          agentLabel="Claude"
          onAnswer={onAnswer}
          disabled
        />
      </section>
      <section data-case="permission">
        <ComputerUsePermissionCard permission="screen-recording" environmentId={null} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  params.get("view") === "gallery" ? <Gallery /> : <ThreadView />,
);

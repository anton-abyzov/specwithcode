import type { DesignDocument, DesignThreadBinding } from "@specweave-studio/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesignEditor } from "../../src/components/design/editor/DesignEditor";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import { createFakeServer } from "./fakeServer";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
// The app's default palette unless ?palette=<theme id> asks for another.
const palette = params.get("palette");
if (palette) applyThemePalette(palette, dark ? "dark" : "light");

const thread = (params.get("thread") ?? "here") as "none" | "here" | "other";
const server = createFakeServer({
  nodes: Number(params.get("nodes") ?? 0),
  thread,
  latencyMs: Number(params.get("latency") ?? 40),
  ...(params.get("member") === null
    ? {}
    : { member: params.get("member") as "edit" | "comment" | "view" }),
});
(window as unknown as { __design: typeof server }).__design = server;

/** Stands in for the app's ChatView: lists what the editor sent to the thread. */
function FixtureChat({ binding }: { binding: DesignThreadBinding }) {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((value) => value + 1);
    window.addEventListener("fixture-sent", update);
    return () => window.removeEventListener("fixture-sent", update);
  }, []);
  const messages = server.sent.filter((message) => message.threadId === binding.threadId);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="fixture-chat">
      <div className="border-b border-border/70 px-4 py-3 text-sm font-medium">Design thread</div>
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm">
        <li className="max-w-[85%] self-start rounded-lg bg-muted px-3 py-2">
          I drafted the booking frame with Harbor UI tokens. Select anything and ask me to change
          it.
        </li>
        {messages.map((message, i) => (
          <li
            key={i}
            className="max-w-[85%] self-end rounded-lg bg-primary/10 px-3 py-2 whitespace-pre-wrap"
            data-testid="fixture-message"
          >
            {message.text.split("\n")[0]}
            {message.images > 0 && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {message.images} image attached
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="m-3 rounded-lg border px-3 py-2.5 text-sm text-muted-foreground">
        Write a message...
      </div>
    </div>
  );
}

function Fixture() {
  const [live, setLive] = useState<DesignDocument | null>(null);
  const [initial] = useState(() => server.head);
  useEffect(() => server.watch(setLive), []);
  const data = useMemo(
    () => ({
      initial,
      live,
      system: server.system,
      assetUrl: (asset: string) => server.assets.get(asset) ?? "",
    }),
    [initial, live],
  );
  return (
    <div className="flex h-dvh min-h-0">
      <DesignEditor
        backend={server.backend}
        data={data}
        designKey="pg.d_fixture"
        renderChat={(binding) => <FixtureChat binding={binding} />}
      />
    </div>
  );
}

const router = createRouter({
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            <Fixture />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
  history: createMemoryHistory(),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

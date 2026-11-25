// The sign-in card and the live view (increment 1488) over a stand-in machine. Query:
//   ?case=card|view|passkey   ?theme=light|dark
// The stand-in seals each frame to the viewer's key with the real WebCrypto code, so the
// view opens frames exactly as it does from a machine. The picture is /frame.jpg when the
// verifier serves one (a real Chrome capture), else a drawn stand-in page.
import type { AccessRequestItem } from "@specweave-studio/client-runtime/access-request";
import { ThreadId, TurnItemId } from "@specweave-studio/contracts";
import { sealForSignIn, signInKeyFingerprint } from "@specweave-studio/shared/signInSeal";
import { DateTime } from "effect";
import { createRoot } from "react-dom/client";

import { AccessRequestPrompt } from "../../src/components/chat/AccessRequestCard";
import { SignInViewer, type SignInViewApi } from "../../src/components/signIn/SignInViewer";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const kind = params.get("case") ?? "view";
const at = DateTime.makeUnsafe("2026-11-25T15:20:00.000Z");

const card = {
  id: TurnItemId.make("turn-item:access-request:fixture"),
  threadId: ThreadId.make("thread-fixture"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "waiting",
  title: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
  type: "access_request",
  accessTitle: "Sign-in needed on m1: app.example.com",
  reason: "The dues sync needs the payments site signed in to export today's payments.",
  accessStatus: "pending",
  subjects: [
    {
      kind: "sign-in",
      key: "sign-in:sign-in-fixture",
      label: "app.example.com",
      detail: "A new Chrome tab, held for you until you press Done.",
      hostLabel: "m1",
    },
  ],
} as unknown as AccessRequestItem;

async function picture(): Promise<{ data: string; width: number; height: number }> {
  const response = await fetch("/frame.jpg").catch(() => null);
  const blob = response?.ok ? await response.blob() : null;
  const image = new Image();
  if (blob) image.src = URL.createObjectURL(blob);
  else {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 520;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 800, 520);
    g.fillStyle = "#111";
    g.font = "bold 28px sans-serif";
    g.fillText("Example Payments", 250, 120);
    g.strokeStyle = "#bbb";
    g.strokeRect(250, 170, 300, 44);
    g.strokeRect(250, 230, 300, 44);
    g.fillStyle = "#1a5fd0";
    g.fillRect(250, 300, 300, 44);
    image.src = canvas.toDataURL("image/jpeg", 0.8);
  }
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return {
    data: canvas.toDataURL("image/jpeg", 0.8).split(",")[1]!,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

const success = <A,>(value: A) => ({ _tag: "Success" as const, value });
const sent: unknown[] = [];
(globalThis as { __signInSent?: unknown[] }).__signInSent = sent;

function standIn(): SignInViewApi {
  let viewerKey = "";
  const shot = picture();
  // A key of the view's own, so typed text is sealed to it as to a machine.
  const viewKey = crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]) as Promise<CryptoKeyPair>;
  return {
    start: async ({ input }: { input: { viewerKey: string } }) => {
      viewerKey = input.viewerKey;
      const spki = new Uint8Array(await crypto.subtle.exportKey("spki", (await viewKey).publicKey));
      const publicKey = btoa(String.fromCharCode(...spki));
      return success({
        viewId: "view-fixture",
        profile: "Chrome m1",
        origin: "https://app.example.com",
        publicKey,
        fingerprint: await signInKeyFingerprint(publicKey),
      });
    },
    frame: async () => {
      const { data, width, height } = await shot;
      const frame = {
        frame: "101:3",
        data,
        width,
        height,
        origin: "https://app.example.com",
        title: "Sign in",
        at: Date.now(),
        ...(kind === "passkey"
          ? {
              passkey: {
                kind: "get",
                rpId: "app.example.com",
                notice:
                  "This page asked for a passkey. Chrome shows its passkey window on this machine, outside this view, and a passkey on your phone works only next to this machine (Bluetooth check). Choose another way to sign in on the page, or Cancel.",
              },
            }
          : {}),
      };
      return success({
        sealed: await sealForSignIn(new TextEncoder().encode(JSON.stringify(frame)), viewerKey),
      });
    },
    input: async ({ input }: { input: unknown }) => {
      sent.push(input);
      return success({});
    },
    end: async () => success({}),
  } as unknown as SignInViewApi;
}

createRoot(document.getElementById("root")!).render(
  kind === "card" ? (
    <div className="mx-auto max-w-xl p-6" data-testid="sign-in-card">
      <AccessRequestPrompt
        item={card}
        agentLabel="Claude"
        onAnswer={async () => null}
        onSignIn={() => {}}
      />
    </div>
  ) : (
    <SignInViewer
      request={{
        environmentId: "env-m1" as never,
        requestId: "sign-in-fixture",
        machine: "m1",
        site: "app.example.com",
      }}
      api={standIn()}
      onClose={() => {}}
    />
  ),
);

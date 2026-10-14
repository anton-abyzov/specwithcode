// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  state,
  root,
  container,
  shell,
  render,
  openFirstThread,
  click,
  prompt,
  paste,
  png,
  sized,
  sendButton,
  alertText,
} from "./ProjectWorkspace.test-fixtures";

describe("coordinator image attachments", () => {
  it("attaches a pasted image and sends it with the message", async () => {
    await render();
    const event = await paste([png()]);
    expect(event.defaultPrevented).toBe(true);
    expect(state.uploadsStarted).toHaveLength(1);
    const strip = container.querySelector(".sws-attachments")!;
    expect(strip.querySelectorAll("img")).toHaveLength(1);
    await prompt("What is wrong here?");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!.click(),
    );
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input).toMatchObject({
      prompt: "What is wrong here?",
      attachments: [{ type: "image", id: "pending-0", name: "shot.png", mimeType: "image/png" }],
    });
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });
  it("sends an image on its own, with no words", async () => {
    await render();
    const send = () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!;
    expect(send().disabled).toBe(true);
    await paste([png()]);
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toHaveLength(1);
  });
  it("leaves pasted text alone", async () => {
    await render();
    const event = await paste([]);
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });
  it("takes a dropped image and removes it on request", async () => {
    await render();
    await paste([png("drop.png")], "drop");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Remove drop.png']")!.click(),
    );
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(state.uploadsReleased).toEqual(state.uploadsStarted);
  });
  it("attaches an image type no provider reads as a file", async () => {
    await render();
    await paste([png("scan.tiff", "image/tiff")]);
    const tile = container.querySelector(".sws-attachment")!;
    expect(tile.getAttribute("data-kind")).toBe("file");
    expect(tile.querySelector("img")).toBeNull();
    expect(alertText()).toBe("");
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "file", name: "scan.tiff", mimeType: "image/tiff" },
    ]);
  });
  it("says why a file it cannot send was not attached", async () => {
    state.maxFileBytes = null;
    await render();
    await paste([png("scan.tiff", "image/tiff")]);
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(alertText()).toContain("'scan.tiff' is not an image, and this host takes images only");
  });
  it("keeps the draft and the image when the upload did not finish", async () => {
    state.uploadFails = true;
    await render();
    await paste([png()]);
    await prompt("Look");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!.click(),
    );
    expect(state.send).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("Look");
    expect(container.querySelector(".sws-composer [role='alert']")?.textContent).toContain(
      "did not upload",
    );
  });
  it("says so when the host takes no attachments", async () => {
    state.uploadsSupported = false;
    await render();
    await paste([png()]);
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(container.querySelector(".sws-composer [role='alert']")?.textContent).toContain(
      "does not accept attachments",
    );
  });
  it("attaches what the file picker returns", async () => {
    await render();
    const picker = container.querySelector<HTMLInputElement>(".sws-composer input[type='file']")!;
    Object.defineProperty(picker, "files", { value: [png("pick.png")], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("[aria-label='Remove pick.png']")).not.toBeNull();
    expect(state.uploadsStarted).toHaveLength(1);
  });
  it("lets a file be dragged onto the message, and answers one it cannot take", async () => {
    await render();
    const over = await paste([], "dragover");
    expect(over.defaultPrevented).toBe(true);
    const dropped = await paste(
      [new File(["x"], "notes.pdf", { type: "application/pdf" })],
      "drop",
    );
    expect(dropped.defaultPrevented).toBe(true);
    expect(container.querySelector("[aria-label='Preview notes.pdf']")).not.toBeNull();
    await paste([new File([], "empty.txt", { type: "text/plain" })], "drop");
    expect(alertText()).toContain("'empty.txt' is empty or could not be read");
    const video = new File(["x"], "video.mov", { type: "video/quicktime" });
    Object.defineProperty(video, "size", { value: 60 * 1024 * 1024 });
    await paste([video], "drop");
    expect(alertText()).toContain("'video.mov' exceeds the 50 MB attachment limit");
  });
  it("takes a photo that arrives with no type, and a screenshot offered only as an item", async () => {
    await render();
    await paste([png("photo.jpg", "")], "drop");
    await paste([], "paste", [{ kind: "file", getAsFile: () => png("item.png") }]);
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(2);
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments[0].mimeType).toBe("image/jpeg");
  });
  it("prepares every image the way the thread composer does before it attaches", async () => {
    // A 6 MB screenshot is under the host's per-image cap but over what the
    // provider takes, so it must shrink like a thread image, not go as is.
    const shrunk = sized("retina.jpg", 3 * 1024 * 1024);
    state.prepareImage.mockResolvedValueOnce({ ok: true, recompressed: true, file: shrunk });
    await render();
    await paste([sized("retina.png", 6 * 1024 * 1024)]);
    expect(state.prepareImage).toHaveBeenCalledTimes(1);
    // The thread composer's own budget, not the host's 10 MB cap.
    expect(state.prepareImage.mock.calls[0]![1]).toBeUndefined();
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "image", name: "retina.jpg", sizeBytes: 3 * 1024 * 1024 },
    ]);
  });
  it("shrinks an image over 10 MB, and says so when it cannot", async () => {
    const shrunk = sized("huge.webp", 4 * 1024 * 1024);
    state.prepareImage.mockResolvedValueOnce({ ok: true, recompressed: true, file: shrunk });
    await render();
    await paste([sized("huge.png", 11 * 1024 * 1024)]);
    expect(state.prepareImage).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[aria-label='Preview huge.webp']")).not.toBeNull();
    await paste([sized("giant.png", 70 * 1024 * 1024)]);
    expect(alertText()).toContain("'giant.png' is too large to attach, even after shrinking it.");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
  });
  it("adds the images that fit under the 20 image limit and says how many were left out", async () => {
    await render();
    await paste(Array.from({ length: 14 }, (_, index) => png(`a${index}.png`)));
    expect(container.querySelector(".sws-attachment-count")).toBeNull();
    await paste([png("a14.png")]);
    expect(container.querySelector(".sws-attachment-count")?.textContent).toBe("15 of 20 images");
    await paste(Array.from({ length: 8 }, (_, index) => png(`b${index}.png`)));
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(20);
    expect(container.querySelector(".sws-attachment-count")?.textContent).toBe("20 of 20 images");
    expect(alertText()).toBe(
      "You can attach up to 20 images per message. 3 images were not added.",
    );
    // The notice stays until it is dismissed.
    await prompt("Still here");
    expect(alertText()).toContain("3 images were not added");
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-composer [aria-label='Dismiss']")!.click(),
    );
    expect(alertText()).toBe("");
    // Files still fit beside a full set of images.
    await paste([new File(["x"], "notes.md", { type: "text/markdown" })], "drop");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(21);
  });
  it("refuses a set of images the host would reject for its total size", async () => {
    await render();
    await paste(
      Array.from({ length: 4 }, (_, index) => sized(`big${index}.png`, 9.5 * 1024 * 1024)),
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(2);
    expect(alertText()).toBe("Images can total up to 22 MB per message. 2 images were not added.");
  });
  it("converts a HEIC photo to JPEG before it attaches", async () => {
    let finish = () => {};
    state.prepareImage.mockImplementationOnce(
      (file: File) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              recompressed: true,
              file: new File(["jpeg"], file.name.replace(".heic", ".jpg"), { type: "image/jpeg" }),
            });
        }),
    );
    await render();
    await paste([png("IMG_0001.heic", "image/heic")], "drop");
    expect(container.querySelector(".sws-attachment[data-state='preparing']")).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    // Enter waits too, without an error that would outlast the preparation.
    await prompt("Here it is");
    await act(async () => {
      container
        .querySelector("#project-prompt")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
    });
    expect(state.send).not.toHaveBeenCalled();
    expect(alertText()).toBe("");
    await act(async () => finish());
    expect(container.querySelector(".sws-attachment[data-state='preparing']")).toBeNull();
    expect(container.querySelector("[aria-label='Preview IMG_0001.jpg']")).not.toBeNull();
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "image", name: "IMG_0001.jpg", mimeType: "image/jpeg" },
    ]);
  });
  it("attaches a pasted file instead of ignoring it", async () => {
    await render();
    const event = await paste([new File(["a,b"], "data.csv", { type: "text/csv" })]);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector("[aria-label='Preview data.csv']")).not.toBeNull();
    expect(container.querySelector(".sws-attachment-size")?.textContent).toBe("1 KB");
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "file", name: "data.csv", mimeType: "text/csv", sizeBytes: 3 },
    ]);
  });
  it("leaves a file to the browser when the clipboard also carries real text", async () => {
    await render();
    const event = await paste(
      [new File(["{}"], "styles.rtf", { type: "text/rtf" })],
      "paste",
      [],
      "Some copied prose",
    );
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });
  it("opens a composer image full screen over every attached image", async () => {
    let urls = 0;
    URL.createObjectURL = vi.fn(() => `blob:preview-${urls++}`);
    await render();
    await paste([png("one.png"), png("two.png"), png("three.png")]);
    const open = container.querySelector<HTMLButtonElement>("[aria-label='Preview two.png']")!;
    expect(open.className).toContain("sws-attachment-open");
    await act(async () => open.click());
    const lightbox = document.querySelector("[data-lightbox]")!;
    expect(lightbox.getAttribute("data-index")).toBe("1");
    expect(lightbox.textContent).toContain("one.png,two.png,three.png");
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-lightbox] button")!.click(),
    );
    expect(document.querySelector("[data-lightbox]")).toBeNull();
  });
  it("removes an image without opening its preview", async () => {
    await render();
    await paste([png("one.png"), png("two.png")]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Remove one.png']")!.click(),
    );
    expect(document.querySelector("[data-lightbox]")).toBeNull();
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
  });
  it("opens an attached file's preview from its chip", async () => {
    await render();
    await paste([new File(["# Plan"], "plan.md", { type: "text/markdown" })], "drop");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Preview plan.md']")!.click(),
    );
    expect(document.querySelector("[data-file-preview='plan.md']")?.textContent).toBe(
      "local bytes",
    );
  });
  it("shows each upload's state and says which image failed", async () => {
    await render();
    await paste([png("one.png"), png("two.png"), png("three.png")]);
    const [one, two, three] = state.uploadsStarted;
    state.uploads = {
      [one!]: { status: "ready", environmentId: "host", attachmentId: "a" },
      [two!]: { status: "uploading", environmentId: "host", progress: 0.42 },
      [three!]: { status: "failed", environmentId: "host", reason: "offline" },
    };
    await paste([]);
    await prompt("x");
    const tiles = [...container.querySelectorAll(".sws-attachment")];
    expect(tiles.map((tile) => tile.getAttribute("data-state"))).toEqual([
      "ready",
      "uploading",
      "failed",
    ]);
    expect(tiles.map((tile) => tile.querySelector(".sws-attachment-state")?.textContent)).toEqual([
      undefined,
      "42%",
      "Failed",
    ]);
    // One spoken line for the strip, never a percentage per image.
    const spoken = [...container.querySelectorAll(".sws-composer [role='status']")].map(
      (node) => node.textContent,
    );
    expect(spoken).toContain("three.png did not upload.");
    expect(container.querySelector(".sws-attachment-state[role]")).toBeNull();
  });
  it("holds the composer while images upload, and sends once", async () => {
    let open = () => {};
    state.uploadGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await render();
    await paste([png()]);
    await prompt("First words");
    await act(async () => sendButton().click());
    expect(state.send).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toContain("Sending");
    expect(
      container.querySelector<HTMLButtonElement>("[aria-label='Remove shot.png']")!.disabled,
    ).toBe(true);
    // A second Enter while the first send waits changes nothing.
    await act(async () => {
      container
        .querySelector("#project-prompt")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      open();
      await state.uploadGate;
    });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input.prompt).toBe("First words");
    expect(container.querySelector(".sws-composer [role='alert']")).toBeNull();
    expect(sendButton().textContent).not.toContain("Sending");
  });
  it("keeps the images and the request identity when delivery is not confirmed", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await render();
    await paste([png()]);
    await prompt("Look at this");
    await act(async () => sendButton().click());
    expect(alertText()).toContain("Host went away");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    expect(state.uploadsReleased).toEqual([]);
    await act(async () => sendButton().click());
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(
      state.send.mock.calls[0]![0].input.commandId,
    );
    expect(state.send.mock.calls[1]![0].input.attachments).toEqual(
      state.send.mock.calls[0]![0].input.attachments,
    );
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(state.uploadsReleased).toEqual(state.uploadsStarted);
  });
  it("does not hold an image it has no right to upload", async () => {
    state.canOperate = false;
    await render();
    await paste([png()]);
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(state.uploadsStarted).toEqual([]);
    expect(alertText()).toContain("Reconnect to this host");
  });
  it("clears an attachment notice once a message is sent", async () => {
    state.maxFileBytes = null;
    await render();
    await paste([png("scan.tiff", "image/tiff")]);
    expect(alertText()).toContain("takes images only");
    await prompt("Just words");
    await act(async () => sendButton().click());
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".sws-composer [role='alert']")).toBeNull();
  });
  it("returns focus to the message after removing an image", async () => {
    await render();
    await paste([png()]);
    const remove = container.querySelector<HTMLButtonElement>("[aria-label='Remove shot.png']")!;
    remove.focus();
    await act(async () => remove.click());
    expect(document.activeElement?.id).toBe("project-prompt");
  });
  it("retains the exact prompt, file and preview across provider-settings navigation", async () => {
    await render();
    await paste([png()]);
    await prompt("  Review this screenshot\nwith exact whitespace  ");
    await act(async () => root.render(<div>Provider settings</div>));
    expect(state.uploadsReleased).toEqual([]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "  Review this screenshot\nwith exact whitespace  ",
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input).toMatchObject({
      prompt: "  Review this screenshot\nwith exact whitespace  ",
      attachments: [{ name: "shot.png" }],
    });
    expect(state.uploadsReleased).toEqual(state.uploadsStarted);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
  it("retains failed sends and their request identity across navigation", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await render();
    await paste([png()]);
    await prompt("Keep this request");
    await act(async () => sendButton().click());
    const request = state.send.mock.calls[0]![0];
    await act(async () => root.render(<div>Provider settings</div>));
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep this request",
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[1]![0]).toEqual(request);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
    await act(async () => root.render(<div>Provider settings</div>));
    await render();
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
  });
  it("keeps a pending send locked across remount and preserves newer composer input", async () => {
    let finish!: (result: unknown) => void;
    state.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await paste([png()]);
    await prompt("First request");
    await act(async () => sendButton().click());
    await act(async () => root.render(<div>Provider settings</div>));
    await render();
    expect(sendButton().disabled).toBe(true);
    await prompt("My next request");
    await act(async () =>
      finish({ _tag: "Success", value: { threadId: "coord", created: false } }),
    );
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "My next request",
    );
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });
  it("finishes image preparation into the retained project draft while settings are open", async () => {
    let finish!: (value: unknown) => void;
    state.prepareImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await paste([png("photo.heic", "image/heic")]);
    await act(async () => root.render(<div>Provider settings</div>));
    await act(async () =>
      finish({ ok: true, recompressed: true, file: png("photo.jpg", "image/jpeg") }),
    );
    await render();
    expect(container.querySelector(".sws-attachment[data-state='preparing']")).toBeNull();
    expect(container.querySelector("[aria-label='Preview photo.jpg']")).not.toBeNull();
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments[0].name).toBe("photo.jpg");
  });
  it("opens the file picker from the attach button", async () => {
    await render();
    const picker = container.querySelector<HTMLInputElement>(".sws-composer input[type='file']")!;
    const opened = vi.spyOn(picker, "click").mockImplementation(() => {});
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Attach files']")!.click(),
    );
    expect(opened).toHaveBeenCalledTimes(1);
    // Any file goes when the host takes files.
    expect(picker.accept).toBe("");
  });
});
it("binds worker attachment identity to retries and sends pending refs to the coordinator", async () => {
  state.attachments = [
    {
      type: "file",
      id: "pending-00000000-0000-4000-8000-000000000001-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    },
  ];
  state.send.mockResolvedValue({ _tag: "Failure", error: new Error("Acknowledgement lost") });
  await render();
  await openFirstThread();
  await click("Reply in selected thread");
  await click("Reply in selected thread");
  const first = state.send.mock.calls[0]![0].input;
  expect(first.attachments).toEqual(state.attachments);
  expect(first.sourceThreadId).toBe("worker");
  expect(state.send.mock.calls[1]![0].input.commandId).toBe(first.commandId);
  state.attachments = [
    { ...state.attachments[0]!, id: "pending-00000000-0000-4000-8000-000000000002-txt" },
  ];
  await click("Reply in selected thread");
  expect(state.send.mock.calls[2]![0].input.commandId).not.toBe(first.commandId);
});

it("shows the original worker follow-up with clickable provenance and preserved attachments", async () => {
  const workerId = "a3111111-2222-4333-8444-555555555555";
  state.shells.push(shell(workerId, { title: "Calendar improvements" }));
  const original = "Keep the next match visible.\n\n**Preserve this formatting.**";
  const wrapped = `User follow-up from selected worker ${workerId}. Review that thread and decide whether to reuse it or route elsewhere.\n\n${original}`;
  state.messages = [
    {
      id: "coordinator-send:project:request:attachment-fingerprint",
      role: "user",
      createdBy: "user",
      senderThreadId: workerId,
      text: wrapped,
      streaming: false,
      attachments: [
        { type: "file", id: "file-1", name: "calendar.txt", mimeType: "text/plain", sizeBytes: 3 },
      ],
    },
  ];
  await render();
  const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
  expect(conversation.textContent).toContain(original);
  expect(conversation.textContent).not.toContain("User follow-up from selected worker");
  expect(conversation.textContent).not.toContain(workerId);
  expect(conversation.textContent).toContain("calendar.txt");
  const header = conversation.querySelector<HTMLElement>(".project-message-source")!;
  expect(header.textContent).toBe("From Calendar improvements");
  const source = header.querySelector<HTMLButtonElement>(`[data-thread-chip="${workerId}"]`)!;
  expect(source.getAttribute("aria-label")).toMatch(/^Open thread Calendar improvements, /);
  expect(source.querySelector(".sws-dot")).not.toBeNull();
  await act(async () => source.click());
  expect(container.querySelector(`[data-native-thread="${workerId}"]`)).not.toBeNull();
  expect(state.messages[0]?.text).toBe(wrapped);
  expect(state.send).not.toHaveBeenCalled();
});

it("keeps agent-origin messages and their sending-thread control unchanged", async () => {
  const text =
    "User follow-up from selected worker worker. Review that thread and decide whether to reuse it or route elsewhere.\n\nAgent update";
  state.messages = [
    {
      id: "coordinator-send:project:agent",
      role: "user",
      createdBy: "agent",
      senderThreadId: "worker",
      text,
      streaming: false,
      attachments: [],
    },
  ];
  await render();
  const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
  expect(conversation.textContent).toContain("Message from a worker");
  expect(conversation.textContent).toContain(text);
  const sender = conversation.querySelector<HTMLButtonElement>('[data-thread-chip="worker"]')!;
  expect(sender.closest(".project-message-source")!.textContent).toMatch(/^Sent by /);
  expect(sender.querySelector(".sws-dot")).not.toBeNull();
  await act(async () => sender.click());
  expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
});

it.each([
  { label: "ordinary typed message", id: "ordinary-message", senderThreadId: "worker" },
  { label: "foreign sender", id: "coordinator-send:project:request", senderThreadId: "foreign" },
])("preserves a literal wrapper from an $label", async ({ id, senderThreadId }) => {
  const text = `User follow-up from selected worker ${senderThreadId}. Review that thread and decide whether to reuse it or route elsewhere.\n\nKeep this literal example.`;
  state.messages = [
    {
      id,
      role: "user",
      createdBy: "user",
      senderThreadId,
      text,
      streaming: false,
      attachments: [],
    },
  ];
  await render();
  const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
  expect(conversation.textContent).toContain(text);
  expect(conversation.querySelector('button[aria-label^="Open source thread"]')).toBeNull();
  expect(conversation.querySelector(".project-message-source")?.textContent ?? "").not.toMatch(
    /^From /,
  );
  expect(state.messages[0]?.text).toBe(text);
  expect(state.send).not.toHaveBeenCalled();
});

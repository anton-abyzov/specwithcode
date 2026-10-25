// Build first: vp build --config apps/web/tests/question-reply/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE and, optionally, a
// headless shell via STUDIO_CHROMIUM_EXECUTABLE. Always headless.
// Usage: node apps/web/tests/question-reply/verify.mjs [/absolute/evidence-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/question-reply/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/question-reply/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SETTLED =
  "This question was already answered or closed, so your reply was not sent. It is still in the box: send it as a message, or clear it.";
const QUESTION = "Which repository binding should workers push to?";
const SENT = "Answer sent.";
const DISMISSED = "Question dismissed.";
const ELSEWHERE = "The question was answered or closed elsewhere.";
// 640 px is a 1280 px window at 200% zoom.
const VIEWPORTS = [
  { name: "360", width: 360, height: 780 },
  { name: "1280", width: 1280, height: 820 },
  { name: "1280-zoom200", width: 640, height: 820 },
];
const receipt = {
  headless: true,
  env: { PWDEBUG: process.env.PWDEBUG, PLAYWRIGHT_HTML_OPEN: process.env.PLAYWRIGHT_HTML_OPEN },
  checks: [],
  screenshots: [],
  videos: [],
};
const check = (name, ok, detail) => {
  receipt.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  NodeAssert.ok(ok, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

try {
  for (const theme of ["light", "dark"]) {
    for (const viewport of VIEWPORTS) {
      const label = `${theme} ${viewport.name}`;
      const size = { width: viewport.width, height: viewport.height };
      const context = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        recordVideo: { dir: output, size },
      });
      const page = await context.newPage();
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name) => {
        const file = NodePath.join(output, `${name}-${theme}-${viewport.name}.png`);
        await page.screenshot({ path: file });
        receipt.screenshots.push(file);
      };
      const open = async (query = "") => {
        await page.goto(`${origin}/?theme=${theme}${query}`);
        await page.waitForSelector("body[data-fixture-ready]");
      };
      const prompt = page.locator("#project-prompt");
      const paste = (selector) =>
        page.evaluate(
          ({ selector, base64 }) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const data = new DataTransfer();
            data.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
            document.querySelector(selector).dispatchEvent(
              new ClipboardEvent("paste", {
                clipboardData: data,
                bubbles: true,
                cancelable: true,
              }),
            );
          },
          { selector, base64: PNG },
        );
      const active = () =>
        page.evaluate(() => ({
          id: document.activeElement?.id ?? "",
          answerInChat: document.activeElement?.hasAttribute("data-answer-in-chat") ?? false,
          requestFocus: document.activeElement?.hasAttribute("data-request-focus") ?? false,
          inDialog: Boolean(document.activeElement?.closest("[role='dialog']")),
        }));
      const live = page.locator("[data-question-live-status]");
      const hears = async (name, text) => {
        await page
          .waitForFunction(
            (expected) =>
              document.querySelector("[data-question-live-status]")?.textContent === expected,
            text,
            { timeout: 3000 },
          )
          .catch(() => {});
        check(`${label}: ${name}`, (await live.textContent()) === text, await live.textContent());
      };
      const fits = async (name) => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        check(`${label}: ${name} has no horizontal scroll`, overflow <= 0, overflow);
      };

      // AC-02 (T-05 add-on): a short worker message keeps "Sent by" on one line.
      await open();
      const source = await page.evaluate(() => {
        const bubble = document.querySelector("[data-fixture-message='worker']");
        const prefix = bubble.querySelector(".project-message-source-prefix");
        const chip = bubble.querySelector(".sws-thread-link");
        const lineHeight = parseFloat(getComputedStyle(prefix).lineHeight) || 20;
        const box = (node) => node.getBoundingClientRect();
        return {
          prefixHeight: box(prefix).height,
          lineHeight,
          prefixClipped: prefix.scrollWidth > Math.ceil(box(prefix).width),
          chipInside: box(chip).right <= box(bubble).right + 0.5,
          bubbleWidth: box(bubble).width,
        };
      });
      check(
        `${label}: "Sent by" stays on one line`,
        source.prefixHeight <= source.lineHeight * 1.5 && !source.prefixClipped,
        source,
      );
      check(`${label}: the sender chip stays inside the bubble`, source.chipInside, source);
      await fits("conversation");

      // AC-06: the live status is in the page, polite and silent, before anything settles.
      check(
        `${label}: a polite live status waits beside the composer`,
        (await live.count()) === 1 &&
          (await live.getAttribute("role")) === "status" &&
          (await live.getAttribute("aria-live")) === "polite" &&
          (await live.textContent()) === "",
      );

      // AC-01, AC-02: the question sits above the message box, named as the coordinator's.
      const card = page.locator("[data-coordinator-question]");
      check(
        `${label}: the card is a labelled region`,
        (await card.getAttribute("aria-label")) === "Question from the coordinator",
      );
      check(
        `${label}: the card names who asks`,
        (await card.locator("[data-question-asker]").innerText()).includes("Coordinator asks"),
      );
      check(
        `${label}: the asker's name is not cut off`,
        await card
          .locator("[data-question-asker]")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      );
      check(
        `${label}: the message box says it answers the question`,
        (await page.locator("label[for='project-prompt']").innerText()) ===
          "Your answer to the coordinator's question",
      );
      await shot("card-above-composer");

      // AC-06: "reply in chat" by keyboard lands in the message box with the draft kept.
      await prompt.fill("Use the registered binding");
      await card.locator("[data-question-reply-in-chat]").first().focus();
      await page.keyboard.press("Enter");
      check(
        `${label}: reply in chat focuses the message box`,
        (await active()).id === "project-prompt",
      );
      await paste("#project-prompt");
      await page.waitForSelector(".sws-attachment");
      await shot("draft-with-image");

      // AC-04: a send the host drops keeps the draft and its image; the resend is the same command.
      await page.evaluate(() => (window.__fixture.next = "interrupted"));
      await page.keyboard.press("Enter");
      await page.waitForSelector(".sws-composer [role='alert']");
      check(
        `${label}: an interrupted send says to send again`,
        (await page.locator(".sws-composer [role='alert']").innerText()).includes("Send it again"),
      );
      check(
        `${label}: the draft survives a failed send`,
        (await page.evaluate(() => window.__fixture.prompt())) === "Use the registered binding" &&
          (await page.evaluate(() => window.__fixture.attachments())) === 1,
      );
      await shot("send-interrupted-draft-kept");
      await prompt.focus();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-coordinator-decision]");
      const responses = await page.evaluate(() => window.__fixture.responses);
      check(
        `${label}: the resend replays the same command`,
        responses.length === 2 && responses[0].commandId === responses[1].commandId,
        responses.map((response) => response.commandId),
      );
      check(
        `${label}: the answer is the typed words, with the image, from chat`,
        responses[1].answers.binding === "Use the registered binding" &&
          responses[1].attachmentsByQuestionId?.binding?.length === 1 &&
          responses[1].answeredInChat === true,
        responses[1],
      );
      // AC-02, AC-03: the decision names the coordinator; the person's bubble holds only their words.
      const decision = page.locator("[data-coordinator-decision] section");
      check(
        `${label}: the decision names the coordinator as the asker`,
        (await decision.getAttribute("aria-label")) === "Decision on a question from Coordinator",
      );
      check(
        `${label}: the decision reads Answered in chat`,
        (await decision.innerText()).includes("Answered in chat"),
      );
      const mine = page.locator("[data-fixture-message='you']").last();
      check(
        `${label}: the reply bubble holds only the person's words`,
        (await mine.innerText()).includes("Use the registered binding") &&
          !(await mine.innerText()).includes(QUESTION),
      );
      check(`${label}: the card settles`, (await card.count()) === 0);
      check(
        `${label}: the message box is plain again`,
        (await page.locator("label[for='project-prompt']").innerText()) ===
          "Message the project coordinator" &&
          (await page.evaluate(() => window.__fixture.prompt())) === "",
      );
      await fits("answered conversation");
      await hears("a screen reader hears the answer was sent, once", SENT);
      await shot("answered-in-chat");

      // AC-03: a question settled elsewhere refuses the reply and keeps it.
      await open();
      await prompt.fill("Registered, please");
      await page.evaluate(() => (window.__fixture.next = "settled"));
      await prompt.press("Enter");
      await page.waitForSelector(".sws-composer [role='alert']");
      check(
        `${label}: a settled question says why the reply was not sent`,
        (await page.locator(".sws-composer [role='alert']").innerText()) === SETTLED,
      );
      await page.waitForSelector("[data-coordinator-decision]");
      check(
        `${label}: the refused reply stays in the box and the card settles`,
        (await page.evaluate(() => window.__fixture.prompt())) === "Registered, please" &&
          (await card.count()) === 0,
      );
      // The alert is the news: the live status does not say it a second time.
      await page
        .waitForFunction(
          () => document.querySelector("[data-question-live-status]")?.textContent !== "",
          undefined,
          { timeout: 1500 },
        )
        .catch(() => {});
      check(
        `${label}: a screen reader hears the settled question once, from the alert`,
        (await live.textContent()) === "" &&
          (await page.locator(".sws-composer [role='alert']").innerText()) === SETTLED,
        await live.textContent(),
      );
      await shot("settled-elsewhere");
      // The way forward: the kept words go as a plain message, not a second answer.
      await prompt.press("Enter");
      await page.waitForFunction(
        () => document.querySelectorAll("[data-fixture-message='you']").length === 2,
      );
      check(
        `${label}: after a settled question the kept reply sends as a message`,
        (await page.evaluate(() => window.__fixture.responses.length)) === 1 &&
          (await mine.innerText()).includes("Registered, please"),
      );

      // AC-06: another window answers; the card goes and the live status says so.
      await open();
      await page.evaluate(() => window.__fixture.settleElsewhere());
      await page.waitForFunction(() => !document.querySelector("[data-coordinator-question]"));
      await hears("a question answered in another window is announced", ELSEWHERE);
      check(
        `${label}: this page sent nothing for it`,
        (await page.evaluate(() => window.__fixture.responses.length)) === 0,
      );

      // AC-06: by keyboard alone, Tab walks the card's controls and then the message box.
      await open();
      await card.locator("button").first().focus();
      const stops = [];
      for (let step = 0; step < 24; step += 1) {
        const stop = await page.evaluate(() => {
          const node = document.activeElement;
          return {
            id: node?.id ?? "",
            inCard: Boolean(node?.closest("[data-coordinator-question]")),
            name: node?.getAttribute("aria-label") || node?.textContent?.trim().slice(0, 40) || "",
          };
        });
        stops.push(stop);
        if (stop.id === "project-prompt") break;
        await page.keyboard.press("Tab");
      }
      const reached = stops.at(-1)?.id === "project-prompt";
      check(
        `${label}: Tab goes from the card's controls straight to the message box`,
        reached && stops.slice(0, -1).every((stop) => stop.inCard),
        stops,
      );
      await page.keyboard.press("Shift+Tab");
      check(
        `${label}: Shift+Tab from the message box goes back to the card`,
        await page.evaluate(() =>
          Boolean(document.activeElement?.closest("[data-coordinator-question]")),
        ),
      );
      // Dismiss by keyboard: the card goes and the live status names the dismissal.
      await card
        .getByRole("button", { name: "Dismiss question without answering", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-coordinator-question]"));
      await hears("a screen reader hears the question was dismissed, once", DISMISSED);

      // AC-02: an option picked on the card folds the answer into the decision.
      await open();
      await card.locator("[data-question-option='A']").click();
      await page.waitForSelector("[data-coordinator-decision]");
      check(
        `${label}: a card answer leaves no bubble of its own`,
        (await page.locator("[data-fixture-message='you']").count()) === 1,
      );
      check(
        `${label}: a card answer reads Sent to the agent`,
        (await decision.innerText()).includes("Sent to the agent"),
      );
      await shot("answered-from-card");

      // AC-05: while the message box can answer, the chip goes there and the dialog points there.
      await open();
      await page.click("[data-fixture-chip]");
      check(
        `${label}: the status chip goes to the message box while it can answer`,
        (await active()).id === "project-prompt" &&
          (await page.locator("[role='dialog']").count()) === 0,
      );
      // The dialog opened anyway, as the overview's request row does; Escape closes it.
      await open("&dialog");
      await page.waitForSelector("[role='dialog']");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
      check(`${label}: Escape closes the requests dialog`, true);
      await open("&dialog");
      await page.waitForSelector("[role='dialog']");
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-answer-in-chat"));
      check(`${label}: the dialog focuses Answer in chat first`, (await active()).answerInChat);
      check(
        `${label}: the dialog has no second answer box while the message box can send`,
        (await page.locator("[role='dialog'] textarea").count()) === 0,
      );
      await shot("dialog-answer-in-chat");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
      check(
        `${label}: Answer in chat closes onto the message box`,
        (await active()).id === "project-prompt",
      );

      // AC-05: a blocked message box sends the answer from the dialog's box, the same draft.
      await open("&blocked");
      await prompt.fill("Registered, please");
      await card.locator("[data-question-reply-in-chat]").first().click();
      await page.waitForSelector("[role='dialog'] [data-coordinator-draft-answer] textarea");
      await page.waitForFunction(() =>
        document.activeElement?.closest("[data-coordinator-draft-answer]"),
      );
      const box = page.locator("[role='dialog'] [data-coordinator-draft-answer] textarea");
      check(
        `${label}: the recovery box holds the same draft`,
        (await box.inputValue()) === "Registered, please",
      );
      check(
        `${label}: the recovery box says why it is there`,
        (await page.locator("[data-recovery-reason]").innerText()).includes(
          "not available on this machine",
        ),
      );
      await paste("[role='dialog'] [data-coordinator-draft-answer] textarea");
      await page.waitForSelector("[role='dialog'] .sws-attachment");
      await fits("recovery dialog");
      await shot("dialog-recovery-box");
      await box.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
      await page.waitForSelector("[data-coordinator-decision]");
      const recovered = (await page.evaluate(() => window.__fixture.responses)).at(-1);
      check(
        `${label}: the recovery box sent the draft and its image`,
        recovered.answers.binding === "Registered, please" &&
          recovered.attachmentsByQuestionId?.binding?.length === 1,
        recovered,
      );
      await shot("recovered-answer");

      // AC-01: a card with two questions takes one chat reply per question, labelled by header.
      await open("&questions=2");
      await prompt.fill("Registered binding");
      await prompt.press("Enter");
      await page.waitForFunction(() =>
        document
          .querySelector("[data-coordinator-question]")
          ?.textContent?.includes("Which branch prefix"),
      );
      check(
        `${label}: the first reply moves the card to the next question without sending`,
        (await page.evaluate(() => window.__fixture.responses.length)) === 0,
      );
      await shot("two-questions-second");
      await prompt.fill("fix/");
      await prompt.press("Enter");
      await page.waitForSelector("[data-coordinator-decision]");
      const both = (await page.evaluate(() => window.__fixture.responses)).at(-1);
      check(
        `${label}: both replies reach the agent in one answer`,
        both.answers.binding === "Registered binding" && both.answers.branch === "fix/",
        both.answers,
      );
      check(
        `${label}: several answers are labelled by question, never the question text`,
        (await mine.innerText()).includes("App binding: Registered binding") &&
          !(await mine.innerText()).includes(QUESTION),
      );
      await shot("two-questions-answered");

      check(`${label}: no page errors`, errors.length === 0, errors);
      const video = page.video();
      await context.close();
      if (video) {
        const file = NodePath.join(output, `question-reply-${theme}-${viewport.name}.webm`);
        await NodeFSP.rename(await video.path(), file);
        receipt.videos.push(file);
      }
    }
  }
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await browser.close();
  server.close();
}
console.log(`${receipt.checks.length} checks passed; evidence in ${output}`);

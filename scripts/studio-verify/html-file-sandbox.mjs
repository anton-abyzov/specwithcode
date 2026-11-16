// Headless proof that a framed HTML file stays on local content.
// Serves the real wrapper and locked policy from HtmlFilePreview, then drives
// headless Chrome. A second origin counts every request and must stay at zero.
//
// node scripts/studio-verify/html-file-sandbox.mjs <output-dir>

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TOP_POLICY = "sandbox allow-scripts allow-forms allow-popups";
const PAGE_FILE = "/Users/antonabyzov/.specwithcode/m4/scratch/2026-11-16-copy-series/review/page.html";
const OUTPUT = process.argv[2];

if (!OUTPUT) {
  console.error("Usage: node scripts/studio-verify/html-file-sandbox.mjs <output-dir>");
  process.exit(2);
}

async function loadModules() {
  try {
    const [preview, refs] = await Promise.all([
      import(new URL("../../apps/server/src/assets/HtmlFilePreview.ts", import.meta.url)),
      import(new URL("../../apps/server/src/assets/HtmlLocalReferences.ts", import.meta.url)),
    ]);
    return { preview, refs };
  } catch (error) {
    if (process.env.HTML_FILE_SANDBOX_REEXEC === "1") throw error;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", process.argv[1], ...process.argv.slice(2)],
      { stdio: "inherit", env: { ...process.env, HTML_FILE_SANDBOX_REEXEC: "1" } },
    );
    child.on("exit", (code) => process.exit(code ?? 1));
    return null;
  }
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function rawGet(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path: requestPath, method: "GET", headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function wavTone() {
  const sampleRate = 8000;
  const samples = sampleRate;
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8000);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function minimalPdf(text) {
  const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

function ensureClip(file) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2f8f5b:s=640x360:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      file,
    ],
    { stdio: "ignore" },
  );
  return result.status === 0 && fs.existsSync(file);
}

function probeDocument(otherOrigin) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font:16px system-ui">
<a id="away" href="${otherOrigin}/clicked" style="display:block;padding:16px 20px">Open the other site</a>
<img id="local" alt="" src="/media/dot.png" width="8" height="8">
<audio id="localmedia" preload="auto"></audio>
<form id="leak" action="${otherOrigin}/form" method="POST"><input name="x" value="1"></form>
<script>
const OTHER = ${JSON.stringify(otherOrigin)};
function once(el, ok, bad, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    el.addEventListener(ok, () => done(ok), { once: true });
    el.addEventListener(bad, () => done(bad), { once: true });
  });
}
function tag(name, attrs) {
  const el = document.createElement(name);
  for (const key of Object.keys(attrs)) el[key] = attrs[key];
  document.body.appendChild(el);
  return el;
}
async function run() {
  const results = {};
  const image = tag("img", { src: OTHER + "/image.png" });
  const script = tag("script", { src: OTHER + "/app.js" });
  const style = tag("link", { rel: "stylesheet", href: OTHER + "/app.css" });
  const video = tag("video", { src: OTHER + "/clip.mp4" });
  const audio = tag("audio", { src: OTHER + "/tone.wav" });
  const fontStyle = tag("style", {});
  fontStyle.textContent = "@font-face{font-family:Leak;src:url(" + OTHER + "/font.woff2)}";
  const settled = await Promise.all([
    once(image, "load", "error", 800),
    once(script, "load", "error", 800),
    once(style, "load", "error", 800),
    once(video, "loadeddata", "error", 800),
    once(audio, "loadeddata", "error", 800),
    fetch(OTHER + "/fetch").then(() => "ok", (error) => "threw:" + error.name),
    new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", OTHER + "/xhr");
      xhr.onload = () => resolve("load:" + xhr.status);
      xhr.onerror = () => resolve("error:" + xhr.status);
      xhr.send();
    }),
    new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket(OTHER.replace(/^http/, "ws") + "/ws"); }
      catch (error) { resolve("threw:" + error.name); return; }
      const timer = setTimeout(() => { try { socket.close(); } catch (error) {} resolve("timeout"); }, 800);
      socket.onerror = () => { clearTimeout(timer); resolve("error"); };
      socket.onopen = () => { clearTimeout(timer); resolve("open"); };
    }),
  ]);
  results.image = settled[0];
  results.script = settled[1];
  results.style = settled[2];
  results.video = settled[3];
  results.audio = settled[4];
  results.fetch = settled[5];
  results.xhr = settled[6];
  results.websocket = settled[7];
  try { results.beacon = String(navigator.sendBeacon(OTHER + "/beacon", "x")); }
  catch (error) { results.beacon = "threw:" + error.name; }
  try { document.fonts.load("16px Leak"); results.font = "asked"; }
  catch (error) { results.font = "threw:" + error.name; }
  try { document.cookie = "a=1"; results.cookie = document.cookie || "empty"; }
  catch (error) { results.cookie = "threw:" + error.name; }
  try { results.parentDocument = String(parent.document); }
  catch (error) { results.parentDocument = "threw:" + error.name; }
  try { parent.location.href = OTHER + "/nav-parent"; results.parentNavigation = "set"; }
  catch (error) { results.parentNavigation = "threw:" + error.name; }
  try { top.location.href = OTHER + "/nav-top"; results.topNavigation = "set"; }
  catch (error) { results.topNavigation = "threw:" + error.name; }
  try { results.open = String(window.open(OTHER + "/open", "_blank")); }
  catch (error) { results.open = "threw:" + error.name; }
  const local = document.getElementById("local");
  results.localImage = local.complete && local.naturalWidth > 0 ? local.naturalWidth : 0;
  const media = document.getElementById("localmedia");
  const localMedia = once(media, "loadeddata", "error", 2000);
  media.src = "/media/tone.wav";
  results.localMedia = await localMedia;
  parent.postMessage({ method: "studio/probe", params: Object.assign({ phase: "checks", href: location.href }, results) }, "*");
  addEventListener("message", (event) => {
    const command = event.data;
    if (!command || command.method !== "studio/probe-cmd") return;
    if (command.params.action === "form") {
      try { document.getElementById("leak").submit(); }
      catch (error) { parent.postMessage({ method: "studio/probe", params: { phase: "form", error: error.name } }, "*"); }
      setTimeout(() => parent.postMessage({ method: "studio/probe", params: { phase: "form-after", href: location.href } }, "*"), 300);
    }
    if (command.params.action === "nav") {
      parent.postMessage({ method: "studio/probe", params: { phase: "nav-begin", href: location.href } }, "*");
      try { location.assign(OTHER + "/nav-self"); }
      catch (error) { parent.postMessage({ method: "studio/probe", params: { phase: "nav", error: error.name } }, "*"); }
      setTimeout(() => parent.postMessage({ method: "studio/probe", params: { phase: "after-nav", href: location.href } }, "*"), 400);
    }
  });
}
run();
</script></body></html>`;
}

function viewerPage(kind, name, body, sourceButton) {
  const button = sourceButton ? `<button type="button">View source</button>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${kind} ${name}</title><style>
    html,body{margin:0;height:100%;background:#161616;color:#eee;font:13px ui-sans-serif,system-ui}
    header{display:flex;align-items:center;gap:10px;height:44px;padding:0 14px;background:#1c1c1c;border-bottom:1px solid #2e2e2e}
    .kind{color:#a3a3a3} .name{font-weight:650}
    button{margin-left:auto;background:#2a2a2a;color:#eee;border:1px solid #3d3d3d;border-radius:8px;padding:5px 10px}
    main{height:calc(100% - 44px);background:#fff;color:#171717;overflow:auto}
    iframe{width:100%;height:100%;border:0;background:#fff}
    img.fit,video.fit{display:block;max-width:100%;max-height:calc(100vh - 44px);margin:0 auto;background:#111}
    audio{display:block;width:min(520px,90%);margin:64px auto}
    .doc{max-width:68ch;padding:28px 36px;font:16.5px/1.5 ui-sans-serif,system-ui}
    .doc h1{font-size:28px;margin:0 0 8px} .doc p{margin:8px 0}
    table{border-collapse:collapse;width:calc(100% - 48px);margin:24px}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e6e6e6}
    .card{max-width:440px;margin:64px auto;padding:28px 24px;border:1px solid #e6e6e6;border-radius:14px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .card b{display:block;margin:8px 0} .card p{color:#666;font-size:14px}
  </style></head><body><header><span class="kind">${kind}</span><span class="name">${name}</span>${button}</header><main>${body}</main></body></html>`;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function startChrome(userDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--force-device-scale-factor=1",
        "--window-size=1280,900",
        `--user-data-dir=${userDir}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not open a debug port.\n${buffer}`)), 20000);
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(new URL(match[1].replace("ws:", "http:")).port) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited ${code} before the debug port opened.\n${buffer}`));
    });
  });
}

function stopProcess(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

async function newPage(port) {
  for (const method of ["PUT", "GET"]) {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method });
    if (!response.ok) continue;
    const page = await response.json();
    if (page.webSocketDebuggerUrl) return page;
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!page) throw new Error(`No Chrome page target: ${JSON.stringify(list)}`);
  return page;
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`DevTools socket failed: ${wsUrl}`)));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  return {
    ready: opened,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "evaluate failed");
  }
  return result.result?.value;
}

async function shoot(cdp, file) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
}

async function go(cdp, url) {
  await cdp.send("Page.navigate", { url });
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const ready = await evaluate(cdp, "document.readyState");
    if (ready === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out loading ${url}`);
}

async function main() {
  const loaded = await loadModules();
  if (!loaded) return;
  const { preview, refs } = loaded;
  fs.mkdirSync(OUTPUT, { recursive: true });
  const mediaDir = path.join(OUTPUT, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const dotPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(mediaDir, "dot.png"), dotPng);
  fs.writeFileSync(path.join(mediaDir, "tone.wav"), wavTone());
  fs.writeFileSync(path.join(mediaDir, "notes.pdf"), minimalPdf("Notes.pdf"));
  const clipPath = path.join(mediaDir, "clip.mp4");
  const hasClip = ensureClip(clipPath);
  const thumbs = path.join(path.dirname(PAGE_FILE), "thumbs");
  const pageSource = fs.existsSync(PAGE_FILE) ? fs.readFileSync(PAGE_FILE, "utf8") : "";
  const localUrls = new Map();
  if (pageSource) {
    for (const filePath of refs.htmlLocalReferencePaths(pageSource, PAGE_FILE)) {
      if (filePath.startsWith(thumbs + path.sep)) localUrls.set(filePath, `/media/${path.basename(filePath)}`);
    }
  }
  const pageHtml = pageSource
    ? refs.rewriteHtmlLocalReferences(pageSource, PAGE_FILE, localUrls)
    : "<!doctype html><title>missing</title><p>page.html was not on disk</p>";

  const hits = [];
  const other = await listen((request, response) => {
    hits.push({ method: request.method, url: request.url ?? "" });
    response.writeHead(204);
    response.end();
  });
  const otherOrigin = `http://127.0.0.1:${other.port}`;
  const probeHtml = probeDocument(otherOrigin);
  const shots = new Map();

  const asset = await listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status, body, headers) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    if (url.pathname === "/harness/probe") {
      send(200, `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts allow-forms" src="/file/probe.html?studio-frame=1"></iframe><script>window.__messages=[];addEventListener("message",function(e){window.__messages.push(e.data);});</script></body></html>`, { "Content-Type": "text/html; charset=utf-8" });
      return;
    }
    if (url.pathname.startsWith("/shots/")) {
      const body = shots.get(url.pathname);
      if (!body) {
        send(404, "missing", { "Content-Type": "text/plain" });
        return;
      }
      send(200, body, { "Content-Type": "text/html; charset=utf-8" });
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      const name = path.basename(url.pathname);
      const filePath = name.endsWith(".jpg") ? path.join(thumbs, name) : path.join(mediaDir, name);
      if (!fs.existsSync(filePath)) {
        send(404, "missing", { "Content-Type": "text/plain" });
        return;
      }
      send(200, fs.readFileSync(filePath), { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
      return;
    }
    if (url.pathname === "/file/probe.html" || url.pathname === "/file/page.html") {
      const mode = preview.htmlFrameMode({
        searchParams: url.searchParams,
        secFetchDest: request.headers["sec-fetch-dest"],
      });
      const headers = preview.htmlPreviewResponseHeaders(mode, TOP_POLICY);
      if (mode === "wrapper") {
        const pageUrl = new URL(url.pathname + url.search, "http://127.0.0.1");
        send(200, preview.htmlPreviewWrapperDocument(preview.htmlPreviewPagePath(pageUrl)), headers);
        return;
      }
      const html = url.pathname.endsWith("probe.html") ? probeHtml : pageHtml;
      send(200, mode === "locked" ? preview.injectHtmlFileLinkScript(html) : html, headers);
      return;
    }
    send(404, "missing", { "Content-Type": "text/plain" });
  });

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? "" });
  let chrome = null;
  let cdp = null;
  try {
    const top = await rawGet(asset.port, "/file/page.html", { "Sec-Fetch-Dest": "document" });
    check("top keeps today's policy", top.headers["content-security-policy"] === TOP_POLICY, top.headers["content-security-policy"]);
    check("top page has no link script", !top.body.includes("data-studio-file-links"), "");
    const wrapped = await rawGet(asset.port, "/file/probe.html?studio-frame=1", { "Sec-Fetch-Dest": "iframe" });
    check("wrapper has no allow-popups", !String(wrapped.headers["content-security-policy"]).includes("allow-popups"), wrapped.headers["content-security-policy"]);
    check("wrapper frames the locked page", wrapped.body.includes("studio-frame=page") && wrapped.body.includes('sandbox="allow-scripts allow-forms"'), "");
    const locked = await rawGet(asset.port, "/file/probe.html?studio-frame=page", { "Sec-Fetch-Dest": "iframe" });
    check("locked policy matches the module", locked.headers["content-security-policy"] === preview.HTML_FILE_LOCKED_POLICY, locked.headers["content-security-policy"]);
    check("locked page has one link script", locked.body.includes("data-studio-file-links"), "");

    if (!fs.existsSync(CHROME)) throw new Error(`Chrome is not at ${CHROME}`);
    chrome = await startChrome(path.join(OUTPUT, `chrome-profile-${process.pid}`));
    const page = await newPage(chrome.port);
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await go(cdp, `http://127.0.0.1:${asset.port}/harness/probe`);
    let messages = [];
    const started = Date.now();
    while (Date.now() - started < 8000) {
      messages = await evaluate(cdp, "window.__messages");
      if (messages.some((item) => item?.params?.phase === "checks")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const probe = messages.find((item) => item?.params?.phase === "checks")?.params ?? {};
    const blocked = (value) => value === "error" || value === "timeout" || String(value).startsWith("threw");
    check("other-origin image blocked", blocked(probe.image), probe.image);
    check("other-origin script blocked", blocked(probe.script), probe.script);
    check("other-origin stylesheet blocked", blocked(probe.style), probe.style);
    check("other-origin video blocked", blocked(probe.video), probe.video);
    check("other-origin audio blocked", blocked(probe.audio), probe.audio);
    check("fetch blocked", String(probe.fetch).startsWith("threw"), probe.fetch);
    check("xhr blocked", String(probe.xhr).startsWith("error"), probe.xhr);
    check("websocket blocked", probe.websocket === "error" || String(probe.websocket).startsWith("threw"), probe.websocket);
    check(
      "beacon never reached the other origin",
      !hits.some((hit) => hit.url.includes("/beacon")),
      `sendBeacon returned ${probe.beacon}`,
    );
    check("document.cookie throws", String(probe.cookie).startsWith("threw"), probe.cookie);
    check("parent.document throws", String(probe.parentDocument).startsWith("threw"), probe.parentDocument);
    check("parent navigation throws", String(probe.parentNavigation).startsWith("threw"), probe.parentNavigation);
    check("top navigation throws", String(probe.topNavigation).startsWith("threw"), probe.topNavigation);
    check("window.open returns nothing", probe.open === "null" || String(probe.open).startsWith("threw"), probe.open);
    check("same-origin image loads", probe.localImage > 0, String(probe.localImage));
    check("same-origin audio loads", probe.localMedia === "loadeddata", probe.localMedia);
    check("no link message before a click", !messages.some((item) => item?.method === "ui/open-link"), "");
    check("other origin got nothing before the click", hits.length === 0, JSON.stringify(hits));

    const point = { x: 120, y: 24 };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    const clickStarted = Date.now();
    let opened = null;
    while (Date.now() - clickStarted < 2000) {
      messages = await evaluate(cdp, "window.__messages");
      opened = messages.find((item) => item?.method === "ui/open-link");
      if (opened) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check("reader click asks the app to open the link", opened?.params?.url === `${otherOrigin}/clicked`, JSON.stringify(opened ?? null));
    check("the click did not request the other origin", hits.length === 0, JSON.stringify(hits));

    async function command(action, phase, waitMs) {
      await evaluate(
        cdp,
        `document.querySelector("iframe").contentWindow.postMessage({method:"studio/probe-cmd",params:{action:${JSON.stringify(action)}}}, "*")`,
      );
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        messages = await evaluate(cdp, "window.__messages");
        if (messages.some((item) => item?.params?.phase === phase)) return messages.find((item) => item?.params?.phase === phase).params;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    }
    const formAfter = await command("form", "form-after", 2000);
    check(
      "form submission stayed on the page",
      Boolean(formAfter) && !String(formAfter.href).includes("/form"),
      formAfter?.href ?? "no form-after message",
    );
    check("form did not reach the other origin", !hits.some((hit) => hit.url.includes("/form")), JSON.stringify(hits));
    const afterNav = await command("nav", "after-nav", 2000);
    let navDocument = "";
    const listed = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
    const navPage = listed.find((item) => String(item.url).includes("nav-self") && item.webSocketDebuggerUrl);
    if (navPage) {
      try {
        const child = connect(navPage.webSocketDebuggerUrl);
        await child.ready;
        await child.send("Runtime.enable");
        navDocument = await evaluate(
          child,
          `[...document.querySelectorAll(".error-code, #main-message, h1, .error-message")].map((node) => node.textContent.trim()).filter(Boolean).join(" | ") || document.body.innerText.slice(0, 240)`,
        );
        child.close();
      } catch (error) {
        navDocument = `attach failed: ${error.message}`;
      }
    }
    const pageStillThere = Boolean(afterNav) && !String(afterNav.href).includes("/nav-self");
    const browserRefused = /ERR_|blocked|interrupted|refused/i.test(navDocument);
    check(
      "own frame navigation was refused",
      !hits.some((hit) => hit.url.includes("/nav-self")) && (pageStillThere || browserRefused),
      pageStillThere ? afterNav.href : navDocument.replace(/\s+/g, " ").slice(0, 240),
    );
    check("navigation did not reach the other origin", !hits.some((hit) => hit.url.includes("/nav-self")), JSON.stringify(hits));

    const cover = fs.existsSync(path.join(thumbs, "ep1-en.jpg")) ? "/media/ep1-en.jpg" : "/media/dot.png";
    const videoBody = hasClip
      ? `<video class="fit" controls src="/media/clip.mp4" poster="${cover}"></video>`
      : `<video class="fit" controls poster="${cover}"></video>`;
    shots.set("/shots/after", viewerPage("Page", "page.html", `<iframe sandbox="allow-scripts allow-forms" src="/file/page.html?studio-frame=1"></iframe>`, true));
    shots.set("/shots/image", viewerPage("Image", "ep1-en.jpg", `<img class="fit" alt="" src="${cover}">`, false));
    shots.set("/shots/video", viewerPage("Video", "clip.mp4", videoBody, false));
    shots.set("/shots/audio", viewerPage("Audio", "tone.wav", `<audio controls src="/media/tone.wav"></audio>`, false));
    shots.set("/shots/markdown", viewerPage("Document", "notes.md", `<article class="doc"><h1>Approval notes</h1><p>The page opens rendered. Local pictures stay on this machine.</p><ul><li>Six videos</li><li>Thirty-seven posts</li></ul></article>`, false));
    shots.set("/shots/csv", viewerPage("Sheet", "posts.csv", `<table><thead><tr><th>name</th><th>kind</th><th>opens</th></tr></thead><tbody><tr><td>page.html</td><td>Page</td><td>rendered</td></tr><tr><td>clip.mp4</td><td>Video</td><td>player</td></tr><tr><td>notes.pdf</td><td>PDF</td><td>viewer</td></tr></tbody></table>`, false));
    shots.set("/shots/pptx", viewerPage("Deck", "notes.pptx", `<div class="card"><b>notes.pptx</b><p>1 slide. The app draws a PowerPoint file saved as .pptx as slides.</p></div>`, false));
    shots.set("/shots/docx", viewerPage("File", "brief.docx", `<div class="card"><b>brief.docx</b><p>Word documents have no preview here.</p><p>Open in default app</p></div>`, false));
    shots.set("/shots/zip", viewerPage("File", "bundle.zip", `<div class="card"><b>bundle.zip</b><p>bundle.zip has no preview here.</p><p>Open in default app</p></div>`, false));

    const pictures = [
      ["after-page-html.png", `http://127.0.0.1:${asset.port}/shots/after`, 1600],
      ["kind-image.png", `http://127.0.0.1:${asset.port}/shots/image`, 400],
      ["kind-video.png", `http://127.0.0.1:${asset.port}/shots/video`, 500],
      ["kind-audio.png", `http://127.0.0.1:${asset.port}/shots/audio`, 300],
      ["kind-pdf.png", `http://127.0.0.1:${asset.port}/media/notes.pdf`, 800],
      ["kind-markdown.png", `http://127.0.0.1:${asset.port}/shots/markdown`, 200],
      ["kind-csv.png", `http://127.0.0.1:${asset.port}/shots/csv`, 200],
      ["kind-pptx.png", `http://127.0.0.1:${asset.port}/shots/pptx`, 200],
      ["kind-docx.png", `http://127.0.0.1:${asset.port}/shots/docx`, 200],
      ["kind-zip.png", `http://127.0.0.1:${asset.port}/shots/zip`, 200],
    ];
    for (const [name, url, pause] of pictures) {
      await go(cdp, url);
      await new Promise((resolve) => setTimeout(resolve, pause));
      await shoot(cdp, path.join(OUTPUT, name));
      check(`screenshot ${name}`, fs.statSync(path.join(OUTPUT, name)).size > 1000, "");
    }
    check("other origin stayed at zero", hits.length === 0, JSON.stringify(hits));
  } finally {
    fs.writeFileSync(path.join(OUTPUT, "result.json"), JSON.stringify({ checks, hits }, null, 2));
    cdp?.close();
    stopProcess(chrome?.child);
    asset.server.close();
    other.server.close();
  }

  let failed = 0;
  for (const item of checks) {
    const mark = item.ok ? "ok" : "FAIL";
    if (!item.ok) failed += 1;
    console.log(`${mark}  ${item.name}${item.detail ? `  ${item.detail}` : ""}`);
  }
  if (failed > 0) {
    console.error(`${failed} check(s) failed. See ${path.join(OUTPUT, "result.json")}`);
    process.exit(1);
  }
  console.log(`sandbox proof passed. shots in ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const output = process.argv.at(-1);
const { fitMacSnapShot, annotationCaptureRect } = require(path.join(output, "capture.cjs"));
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const size = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
app.setPath("userData", path.join(output, "private-electron-home"));
app.commandLine.appendSwitch("headless");
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    try {
      await win.loadURL(
        "data:text/html," +
          encodeURIComponent(`<!doctype html><title>Capture quality fixture</title>
<body style="margin:0;background:#101828;color:white"><h1 id="selected" style="position:absolute;left:240px;top:300px;width:380px;height:80px;margin:0;background:#146e49">SELECTED CONTEXT TEXT</h1></body>`),
      );
      const sourceUrl = await win.webContents.executeJavaScript(`(() => {
      const c = document.createElement('canvas'); c.width = 3024; c.height = 1964;
      const ctx = c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
      ctx.fillStyle='#17253e'; ctx.font='26px monospace';
      for(let y=50;y<1900;y+=40) ctx.fillText('const snapshot = preserveRetinaPixels(); // 0O1lI {} []',40,y);
      return c.toDataURL('image/png');
    })()`);
      const source = Buffer.from(sourceUrl.split(",")[1], "base64");
      const before = fitMacSnapShot(source, { width: 1512, height: 982 });
      const after = fitMacSnapShot(source);
      fs.writeFileSync(path.join(output, "retina-source.png"), source);
      fs.writeFileSync(path.join(output, "retina-before.png"), before);
      fs.writeFileSync(path.join(output, "retina-after.png"), after);
      fs.writeFileSync(
        path.join(output, "retina-before-detail.png"),
        nativeImage
          .createFromBuffer(before)
          .resize({ width: 3024, height: 1964 })
          .crop({ x: 20, y: 15, width: 900, height: 190 })
          .toPNG(),
      );
      fs.writeFileSync(
        path.join(output, "retina-after-detail.png"),
        nativeImage.createFromBuffer(after).crop({ x: 20, y: 15, width: 900, height: 190 }).toPNG(),
      );
      assert.deepEqual(size(before), { width: 1512, height: 982 });
      assert.equal(sha(after), sha(source));
      const oversized = nativeImage
        .createFromBuffer(source)
        .resize({ width: 9000, height: 4500 })
        .toPNG();
      assert.deepEqual(size(fitMacSnapShot(oversized)), { width: 8000, height: 4000 });
      const annotationCases = [];
      for (const zoom of [1, 1.5, 0.75]) {
        win.webContents.setZoomFactor(zoom);
        // Expose the otherwise closed shadow only inside this private test fixture.
        await win.webContents.executeJavaScript(`(() => {
        if (!window.__originalAttachShadow) {
          window.__originalAttachShadow = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function(options) { return window.__originalAttachShadow.call(this, {...options, mode:'open'}); };
        }
        const listeners = {}; window.__picked = null;
        window.__ipc = { on(channel, listener) { (listeners[channel] ??= []).push(listener); },
          send(channel, ...args) { if(channel === 'preview:element-picked') window.__picked = args; } };
        window.__startPick = () => listeners['preview:start-pick'].forEach(listener => listener({}, undefined, false));
      })()`);
        await win.webContents.executeJavaScript(
          fs.readFileSync(path.join(output, "picker.js"), "utf8"),
        );
        const picked = await win.webContents.executeJavaScript(`(async () => {
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        window.__startPick();
        const selected = document.querySelector('#selected'); const rect=selected.getBoundingClientRect();
        const point = {clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2,bubbles:true,button:0};
        selected.dispatchEvent(new PointerEvent('pointerdown', point));
        selected.dispatchEvent(new PointerEvent('pointerup', point));
        const root=[...document.querySelectorAll('[data-studio-annotation-ui]')].find(e=>e.shadowRoot).shadowRoot;
        const comment=root.querySelector('textarea'); comment.value='Keep my annotation text';
        comment.dispatchEvent(new Event('input',{bubbles:true}));
        [...root.querySelectorAll('button')].find(b=>b.textContent==='Attach').click();
        for(let i=0;i<100 && !window.__picked;i++) await new Promise(resolve=>setTimeout(resolve,10));
        if(!window.__picked) throw new Error('Picker did not submit');
        return window.__picked;
      })()`);
        const [annotation, rect] = picked;
        assert.equal(annotation.comment, "Keep my annotation text");
        assert.equal(annotation.elements[0].element.selector, "#selected");
        assert.match(annotation.elements[0].element.htmlPreview, /SELECTED CONTEXT TEXT/);
        const corrected = annotationCaptureRect(rect, zoom);
        const oldPng = (await win.webContents.capturePage(rect, { stayHidden: true })).toPNG();
        const newPng = (await win.webContents.capturePage(corrected, { stayHidden: true })).toPNG();
        fs.writeFileSync(path.join(output, `annotation-${zoom}-before.png`), oldPng);
        fs.writeFileSync(path.join(output, `annotation-${zoom}-after.png`), newPng);
        const image = nativeImage.createFromBuffer(newPng);
        const bitmap = image.toBitmap();
        let greenPixels = 0;
        for (let i = 0; i < bitmap.length; i += 4)
          if (bitmap[i + 1] > bitmap[i] * 1.05 && bitmap[i + 1] > bitmap[i + 2] * 1.4)
            greenPixels++;
        assert(greenPixels > 1000, "Crop must contain the selected green heading");
        annotation.screenshot = {
          dataUrl: `data:image/png;base64,${newPng.toString("base64")}`,
          ...size(newPng),
          cropRect: rect,
        };
        fs.writeFileSync(
          path.join(output, `annotation-${zoom}.json`),
          JSON.stringify(annotation, null, 2),
        );
        // Provider adapters read attachment bytes and base64-encode without resizing.
        assert.equal(
          sha(Buffer.from(annotation.screenshot.dataUrl.split(",")[1], "base64")),
          sha(newPng),
        );
        annotationCases.push({
          zoom,
          rect,
          corrected,
          beforeBytes: oldPng.length,
          afterBytes: newPng.length,
          greenPixels,
        });
        await win.webContents.executeJavaScript(
          `document.querySelectorAll('[data-studio-annotation-ui]').forEach(e=>e.remove())`,
        );
      }
      const receipt = {
        headless: true,
        offscreen: true,
        visibleWindows: 0,
        nativeCapture: {
          source: size(source),
          before: size(before),
          after: size(after),
          sourceSha256: sha(source),
          afterSha256: sha(after),
          boundedOversize: true,
        },
        annotationCases,
        contextPreserved: true,
        providerBase64RoundTrip: true,
        limits:
          "Private generated fixture and production capture helpers. No live OS shortcut, clipboard write, paid provider turn, or installed-app acceptance.",
      };
      fs.writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    } finally {
      win.destroy();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

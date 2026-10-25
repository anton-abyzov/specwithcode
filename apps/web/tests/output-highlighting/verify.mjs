/** Run window.verifyOutputFixture() through the app's headless preview_evaluate.
 * No server, provider, auth or external resources are used by this fixture. */
export async function verifyOutputFixture() {
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const frame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const luminance = (rgb) =>
    rgb
      .map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const dark = document.documentElement.classList.contains("dark");
  const actualBackground = getComputedStyle(document.body)
    .backgroundColor.match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
  check(
    "theme surface matches tokens",
    dark ? luminance(actualBackground) < 0.1 : luminance(actualBackground) > 0.8,
  );
  const bg = luminance(dark ? [48, 48, 48] : [237, 237, 237]);
  let minContrast = Infinity;
  for (const token of document.querySelectorAll("code span[style]")) {
    if (!token.textContent.trim()) continue;
    const color = getComputedStyle(token)
      .color.match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
    const fg = luminance(color);
    minContrast = Math.min(minContrast, (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05));
  }
  check("token contrast AA on default surfaces", minContrast >= 4.5);
  for (const id of Object.keys(window.fixtureBytes).filter((key) => key !== "large")) {
    const panel = document.getElementById(id);
    check(`${id}: grammar`, panel.querySelector("section").dataset.language === id);
    check(
      `${id}: colored`,
      new Set([...panel.querySelectorAll("code span[style]")].map((e) => e.style.color)).size >= 2,
    );
    check(
      `${id}: exact rendered bytes`,
      panel.querySelector("code").textContent === window.fixtureBytes[id],
    );
    panel.querySelector(`[aria-label="Copy ${id}"]`).click();
    await frame();
    check(`${id}: exact copied bytes`, window.copied === window.fixtureBytes[id]);
  }
  for (const id of ["mixed", "ansi", "unknown", "large"])
    check(`${id}: plain fallback`, !document.querySelector(`#${id} code span[style]`));
  check(
    "ANSI presentation",
    document.querySelector("#ansi code").textContent === "␛[32mPASS␛[0m\r\n",
  );
  check(
    "shared unsupported grammar",
    document.querySelector("#shared pre").textContent === "unknown grammar stays readable\r\n",
  );
  document.querySelector("#stream button").click();
  await frame();
  check(
    "stream current bytes",
    document.querySelector("#stream code").textContent ===
      "export const View = () => <main>streamed</main>;\r\n",
  );
  check("stream grammar", document.querySelector("#stream section").dataset.language === "tsx");
  const large = document.querySelector("#large");
  check("1 MiB source", large.querySelector("code").textContent.length === 1024 * 1024);
  check(
    "large scroll",
    large.querySelector("pre").scrollHeight > large.querySelector("pre").clientHeight,
  );
  const start = performance.now();
  large.querySelector('[aria-label="Wrap large lines"]').click();
  await frame();
  check(
    "large wrap",
    large.querySelector('[aria-label="Wrap large lines"]').getAttribute("aria-pressed") === "true",
  );
  large.querySelector('[aria-label="Expand large"]').click();
  await frame();
  check("large expand", !!large.querySelector('[aria-label="Collapse large"]'));
  large.querySelector('[aria-label="Copy large"]').click();
  await frame();
  check("large exact copy", window.copied === window.fixtureBytes.large);
  const interactionMs = performance.now() - start;
  check("large responsive under 2 seconds", interactionMs < 2000);
  large.querySelector('[aria-label="Collapse large"]').click();
  await frame();
  return {
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    checks,
    minContrast,
    interactionMs,
    passed: true,
  };
}

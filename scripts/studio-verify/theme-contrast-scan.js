// Browser-side WCAG text contrast scan. Evaluated in the page by theme-contrast.mjs.
// Returns one record per visible text element below AA (4.5:1, or 3:1 for large
// text and disabled controls).
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const rgba = (value) => {
    if (cache.has(value)) return cache.get(value);
    let result = null;
    if (value && value !== "transparent" && !/^rgba\(0, 0, 0, 0\)$/.test(value)) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      result = a === 0 ? null : { r, g, b, a: a / 255 };
    }
    cache.set(value, result);
    return result;
  };
  const over = (top, alpha, bottom) => ({
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  });
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c) =>
    "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const opacityOf = (element) => {
    let value = 1;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      value *= Number(getComputedStyle(node).opacity);
    }
    return value;
  };
  const describe = (element) => {
    const parts = [];
    for (
      let node = element;
      node && node.nodeType === 1 && parts.length < 4;
      node = node.parentElement
    ) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : "";
      if (cls) part += `.${cls.slice(0, 40)}`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  // Composite every painted background between the element and the root, then
  // the text itself. An ancestor with opacity < 1 is a CSS group: its subtree
  // (background and text together) is painted, then blended over what was
  // beneath it, so a faded button keeps its internal contrast relation.
  // Gradients contribute each color stop; the darkest and lightest results are
  // kept so text is judged against its worst-case backdrop. Bitmap images are
  // ignored (artwork sits under readable surfaces by design).
  const COLOR = /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
  const extremes = (states) => {
    if (states.length <= 2) return states;
    const sorted = [...states].sort((a, b) => luminance(a.cur) - luminance(b.cur));
    return [sorted[0], sorted[sorted.length - 1]];
  };
  const pairsFor = (element, fg) => {
    const nodes = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement)
      nodes.push(node);
    let states = [{ cur: { r: 255, g: 255, b: 255 }, groups: [] }];
    for (const node of nodes.reverse()) {
      const style = getComputedStyle(node);
      const opacity = Number(style.opacity);
      if (opacity < 1)
        states = states.map((s) => ({ cur: s.cur, groups: [...s.groups, [s.cur, opacity]] }));
      const color = rgba(style.backgroundColor);
      if (color) states = states.map((s) => ({ ...s, cur: over(color, color.a, s.cur) }));
      if (/gradient/.test(style.backgroundImage)) {
        const stops = (style.backgroundImage.match(COLOR) ?? []).map(rgba).filter(Boolean);
        if (stops.length) {
          states = extremes(
            states.flatMap((s) => stops.map((stop) => ({ ...s, cur: over(stop, stop.a, s.cur) }))),
          );
        }
      }
    }
    return states.map(({ cur, groups }) => {
      let bg = cur;
      let text = over(fg, fg.a, cur);
      for (const [saved, opacity] of [...groups].reverse()) {
        bg = over(bg, opacity, saved);
        text = over(text, opacity, saved);
      }
      return { bg, text };
    });
  };
  const failures = [];
  let checked = 0;
  const skips = {};
  const skip = (reason) => (skips[reason] = (skips[reason] ?? 0) + 1);
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const content = text.textContent.replace(/\s+/g, " ").trim();
    if (!content || !/[\p{L}\p{N}]/u.test(content)) continue;
    const element = text.parentElement;
    if (!element || seen.has(element)) continue;
    seen.add(element);
    if (element.closest("svg, canvas, [aria-hidden='true'], .sr-only, [inert]")) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.display === "none") continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = range.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth)
      continue;
    // Skip text that is clipped away (screen-reader-only patterns, overflow masks).
    const probe = document.elementFromPoint(
      Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 6))),
      Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)),
    );
    if (!probe || !(probe === element || element.contains(probe) || probe.contains(element))) {
      skip("covered");
      continue;
    }
    const fg = rgba(style.color);
    if (!fg) continue;
    if (style.webkitTextFillColor && rgba(style.webkitTextFillColor) === null) continue;
    const alpha = fg.a * opacityOf(element);
    // Fully faded text (hover-only hints, exit animations) is not shown.
    if (alpha < 0.05) {
      skip("invisible");
      continue;
    }
    checked += 1;
    let bg,
      effective,
      value = Infinity;
    for (const pair of pairsFor(element, fg)) {
      const candidateRatio = ratio(pair.text, pair.bg);
      if (candidateRatio < value) [bg, effective, value] = [pair.bg, pair.text, candidateRatio];
    }
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const control = element.closest(
      "button, input, select, textarea, [role=button], [role=option], [role=menuitem], [role=tab]",
    );
    const disabled = Boolean(
      control &&
      (control.matches(":disabled, [aria-disabled='true'], [data-disabled]") ||
        element.closest("[aria-disabled='true'], [data-disabled]")),
    );
    // WCAG exempts inactive controls; Studio still keeps their labels at 3:1.
    const required = large || disabled ? 3 : 4.5;
    if (value + 0.005 >= required) continue;
    failures.push({
      text: content.slice(0, 60),
      ratio: Math.round(value * 100) / 100,
      required,
      fg: hex(effective),
      bg: hex(bg),
      fontSize: size,
      disabled,
      placeholder: false,
      path: describe(element),
    });
  }
  for (const field of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
    if (!field.placeholder || field.value) continue;
    const rect = field.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.top > innerHeight || rect.bottom < 0) continue;
    const style = getComputedStyle(field, "::placeholder");
    const fg = rgba(style.color);
    if (!fg) continue;
    let bg,
      effective,
      value = Infinity;
    for (const pair of pairsFor(field, fg)) {
      const candidateRatio = ratio(pair.text, pair.bg);
      if (candidateRatio < value) [bg, effective, value] = [pair.bg, pair.text, candidateRatio];
    }
    if (value + 0.005 >= 4.5) continue;
    failures.push({
      text: field.placeholder.slice(0, 60),
      ratio: Math.round(value * 100) / 100,
      required: 4.5,
      fg: hex(effective),
      bg: hex(bg),
      fontSize: parseFloat(getComputedStyle(field).fontSize),
      disabled: field.disabled,
      placeholder: true,
      path: describe(field),
    });
  }
  return { checked, skips, failures };
})();

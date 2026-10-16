/**
 * Scripts evaluated in the user's page through CDP `Runtime.evaluate`. Each
 * is a self-contained expression; arguments are spliced in as JSON so a page
 * can never turn them into code.
 */

const ROLE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=switch]",
  "[role=combobox]",
  "[role=textbox]",
  "[contenteditable='']",
  "[contenteditable=true]",
  "[onclick]",
].join(",");

const NAME_OF = `(el) => (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || (el.tagName !== 'INPUT' ? '' : el.value) || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 120)`;

export const MAX_SNAPSHOT_ELEMENTS = 300;

/** Visible text plus every visible interactive element, each tagged with a ref the other tools accept. */
export function snapshotScript(maxTextChars: number): string {
  return `(() => {
  const MAX_TEXT = ${JSON.stringify(maxTextChars)};
  const nameOf = ${NAME_OF};
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'INPUT') return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', range: 'slider', image: 'button' })[el.type] || 'textbox';
    if (el.isContentEditable) return 'textbox';
    return ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' })[el.tagName] || 'generic';
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  for (const old of document.querySelectorAll('[data-swc-ref]')) old.removeAttribute('data-swc-ref');
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(${JSON.stringify(ROLE_SELECTOR)})) {
    if (elements.length >= ${MAX_SNAPSHOT_ELEMENTS}) break;
    if (!visible(el)) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-swc-ref', ref);
    const item = { ref, role: roleOf(el), name: nameOf(el) };
    if (el.tagName === 'A' && el.href) item.href = String(el.href).slice(0, 300);
    if (el.type === 'password') item.value = el.value ? '(hidden)' : '';
    else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.value) item.value = String(el.value).slice(0, 200);
    if (el.checked === true || el.getAttribute('aria-checked') === 'true') item.checked = true;
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    elements.push(item);
  }
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, MAX_TEXT), textTruncated: text.length > MAX_TEXT, elements };
})()`;
}

export interface ElementTarget {
  readonly ref?: string | undefined;
  readonly selector?: string | undefined;
}

/**
 * Finds the target, scrolls it into view and reports its center. With
 * `focus`, also focuses it and, with `clear`, selects its current value so
 * typed text replaces it.
 */
export function locateScript(
  target: ElementTarget,
  options: { focus?: boolean; clear?: boolean } = {},
): string {
  return `(() => {
  const ref = ${JSON.stringify(target.ref ?? null)};
  const selector = ${JSON.stringify(target.selector ?? null)};
  const nameOf = ${NAME_OF};
  let el = null;
  try {
    el = ref ? document.querySelector('[data-swc-ref="' + CSS.escape(ref) + '"]') : document.querySelector(selector);
  } catch (error) {
    return { found: false, error: String(error && error.message || error) };
  }
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  if (${JSON.stringify(options.focus === true)}) {
    el.focus();
    if (${JSON.stringify(options.clear === true)}) {
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select();
      else if (el.isContentEditable) document.execCommand('selectAll');
    }
  }
  return {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: el.tagName.toLowerCase(),
    name: nameOf(el).slice(0, 80),
  };
})()`;
}

/** Clicks with the DOM when the element has no box to aim at. */
export function domClickScript(target: ElementTarget): string {
  return `(() => {
  const ref = ${JSON.stringify(target.ref ?? null)};
  const selector = ${JSON.stringify(target.selector ?? null)};
  const el = ref ? document.querySelector('[data-swc-ref="' + CSS.escape(ref) + '"]') : document.querySelector(selector);
  if (!el) return false;
  el.click();
  return true;
})()`;
}

export const READY_STATE_SCRIPT = "document.readyState";
export const PAGE_IDENTITY_SCRIPT = "({ title: document.title, url: location.href })";

export interface KeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

/** The CDP key description for a named key or a single character; null when unknown. */
export function keyDefinition(name: string): KeyDefinition | null {
  const named = NAMED_KEYS[name.trim().toLowerCase()];
  if (named) return named;
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(name);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: name,
    };
  }
  return null;
}

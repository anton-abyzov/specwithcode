/** Assertions executed through SpecWithCode preview_evaluate after preview_click.
 * The caller supplies this function's source and saves its returned receipt.
 * Browser is headless; PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never, HTML open=never.
 */
export function checkAttention(expected) {
  const summary = document.querySelector(".sws-threads-head")?.textContent ?? "";
  const badge =
    document.querySelector('[aria-label="Project sidebar"] .sws-count')?.textContent ?? "";
  const actionView = document.querySelector('[aria-label="Project attention"]');
  const working = Number(
    document
      .querySelector('[data-group="Working"] .sws-group-count')
      ?.textContent?.match(/\d+/)?.[0] ?? 0,
  );
  const actions = actionView?.querySelectorAll("button").length ?? 0;
  if (!summary.includes(expected.summary)) throw new Error(`Summary mismatch: ${summary}`);
  if (expected.badge === null ? badge !== "" : !badge.includes(expected.badge))
    throw new Error(`Badge mismatch: ${badge}`);
  if (working !== expected.working) throw new Error(`Working group mismatch: ${working}`);
  if (actions !== expected.actions) throw new Error(`Action target count mismatch: ${actions}`);
  if (document.documentElement.scrollWidth > innerWidth)
    throw new Error("Horizontal page overflow");
  return {
    scenario: expected.scenario,
    width: innerWidth,
    summary,
    badge,
    working,
    actions,
    passed: true,
  };
}

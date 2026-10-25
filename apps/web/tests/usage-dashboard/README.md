# Usage dashboard fixture

Renders the production UsagePage with synthetic local usage and provider state. It never connects to a provider or live store. State boundaries, native sidebar shell, Limits and price settings are mocked; monetary merging, filters, chart, cost basis and model breakdown are real.

From `/Users/you/.specwithcode/m4/worktrees/usage-cost-dashboard`, build with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/usage-dashboard/vite.config.ts`, then serve `.artifacts/usage-dashboard/site` on a loopback port.

Use the headless SpecWithCode preview (`preview_open` with `open: false`, `show: false`). Open `/?theme=dark`, then `/?theme=light`. Add `&unpriced=1` for entirely unknown cost. Capture 1440px and 390px layouts to files. All standalone browser runs must explicitly use `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`.

Acceptance: provider button narrows totals, chart, cost categories and models; the searchbox narrows model rows; chart Home/End/arrow keys move, Enter pins, Escape unpins; Clear filters restores all history. Unknown monetary totals and rows read Unpriced. Billed spend reads Not reported. The Codex fixture plan reads 62% left. GitHub Copilot is explicitly outside these totals. At 390px there is no horizontal document overflow.

Saved fixture evidence is separate from installed-app acceptance in `/Users/you/.specwithcode/m4/evidence/usage-cost-dashboard-20261023/`.

The forecast uses the production measured-history calculation and renders a separate next-seven-days scenario. Default history has seven complete, active, recently read days, yielding approximately $615 API-equivalent value and 15.3M processed tokens. Selecting Codex yields approximately $316 and three model rows. All figures are synthetic fixture values.

Query parameters: `stale=1` makes history two hours old; `insufficient=1` leaves two dates; `partial=1` marks a source incomplete; `unpriced=1` removes monetary prices while retaining measured tokens; `partial-cost=1` leaves some recent records unpriced. The first three suppress forecasts; unpriced history suppresses only the monetary scenario. None may display unknown money as zero.

Verify the shared date cursor with keyboard arrows, Home/End and Enter, and a direct pointer click without a preceding hover. The daily chart uses exact straight segments and sample markers; unknown monetary periods break the path. The fixture's October 1 cursor reads Claude $71, Codex $22, total $93. Pinned model details intersect the same day/hour; Escape closes the dialog before clearing the page pin. The full-width cost-type bar exposes all five segment values and shares to keyboard focus. Model rows retain cost, share and tokens at 390px, with share below the name.

App-wide sheet (1029): `/?theme=dark&shell=before` shows the old route behaviour, where the Usage page replaces the coordinator and threads panes. `/?theme=dark&shell=after` opens the same page as the Settings-style sheet over a stand-in shell (sidebar, coordinator, threads; only the Usage page is real, and the Limits rows are synthetic). The headless capture script and results are in `/Users/you/.specwithcode/m4/evidence/usage-limits-overlay-20261023/`.

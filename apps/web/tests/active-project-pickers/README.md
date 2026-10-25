# Code Review project picker fixture

Uses SpecWithCode's real compact filter control and narrow filter menu with synthetic projects. No server, provider turn, credentials or live state is used. The route imports the same compact control that this fixture exercises.

Start the Vite dev server with `node node_modules/vite-plus/bin/vp dev --config apps/web/tests/active-project-pickers/vite.config.ts`. No production build is required.

Run `node apps/web/tests/active-project-pickers/verify.mjs /absolute/evidence/directory`. Set `PLAYWRIGHT_MODULE` to an installed Playwright package and `STUDIO_TEST_CHROMIUM` to an installed Chrome executable if they are not on the normal resolution path. `PICKER_FIXTURE_URL` can override the default loopback origin.

The verifier explicitly launches with `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`. It saves 24 screenshots and a JSON receipt across two viewports, two themes and six selection states. It checks active-only alternatives, personal contexts excluded from Code Review, disabled preserved selections with same-name machine/path labels, no horizontal overflow, and the exact environment/project identity reached after choosing a sibling checkout. This is source evidence; installed acceptance is a separate postrelease check.

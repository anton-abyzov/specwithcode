# Subscriptions and resets

Open **Usage**, choose **Limits**, then **Subscriptions**. The view lists every subscription
signed in on your connected machines, so you can see which quota is about to reset unused.

## What each row shows

- The provider, plan and signed-in email, and the machines the account is signed in on. A machine
  that is offline keeps its last reading, with its age.
- Each window with what is left and the time to its reset. A window is amber when it resets soon
  with much of it unused: under 24 hours for a weekly window with at least 40% left.
- When the subscription renews. If the provider does not report a date, choose **Set day** and
  enter the day of the month it renews. The day is saved on your main machine.
- Banked resets and when the next one expires.
- **Lost at last reset**: the share of the window that was unused when it last reset. "up to"
  means the last reading was taken more than two hours before the reset, so the real loss may be
  smaller. "Not reported" means the app has not seen a reset of that account yet.

Accounts about to lose quota are listed first.

## Used against lost

Under the list, a chart and table show what each weekly or monthly reset found used and what it
left unused, for the last four weeks. Figures are a percent of one account's window, because
that is what providers report. **Copy report** copies the table as Markdown.

A token estimate appears only when one account of that provider was in use, so the tokens behind
its used percent can be measured. Otherwise the table says "Not measurable".

## How resets are recorded

Each machine records a reset when it reads a weekly or monthly window before and after it starts
over, and keeps the record for a year. Nothing is recorded when the app was not running for a
whole window, because the spend in that time is unknown. Records start from the version that
added this view; earlier resets are not shown.

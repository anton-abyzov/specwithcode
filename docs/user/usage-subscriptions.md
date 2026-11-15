# Subscriptions and resets

Open **Usage**, choose **Limits**, then **Subscriptions**. The view lists every subscription
signed in on your connected machines, so you can see which quota is about to reset unused.

## The dashboard

The page opens with a dashboard. One row of filters scopes everything under it:

- **Range**: 1W, 4W (the default), 12W or 1Y. The chart always draws twelve columns, weeks or months, so the range sits in context; columns before the range are dimmed.
- **Group by**: provider, account or machine.

**Efficiency** is the share of the quota you planned to use that you did use before each reset, averaged over the range. Each account counts equally, or by its monthly price when every account in the range has one. The score needs two resets in the range; before that it reads "Not enough history yet".

A subscription you keep as a spare should not count against you. Group by account, click "plan 100%" on its row and set the share you plan to use, for example 30%. Using 30% of it then counts in full. The same form takes the monthly price.

Beside the score: what was left unused (with a token estimate where one can be measured), the quota that resets within 24 hours, and banked resets with the next expiry.

Point at a column to read each group's figure for that week. Click it to show only that week's resets in the table; "Show the whole range" goes back. The table lists ten resets a page, newest first. Click a row to open it: how long before the reset the app last read the account (a read more than two hours before makes the unused figure an upper bound, shown as "up to"), the planned share, where the account is signed in, and, for the last 14 days, use through the period against an even pace.

The rows under "Right now" are the live windows, renewal days and banked resets described below.

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

## The four-week report

**Copy 4-week report** beside "Right now" copies a Markdown table of what each weekly or monthly
reset found used and what it left unused, for the last four weeks. Figures are a percent of one
account's window, because that is what providers report.

A token estimate appears only when one account of that provider was read in the period, so the
tokens behind its used percent can be measured. Otherwise the table says "Not measurable".

## How resets are recorded

Each machine records a reset when it reads a weekly or monthly window before and after it starts
over, and keeps the record for a year. Nothing is recorded when the app was not running for a
whole window, because the spend in that time is unknown. Records start from the version that
added this view; earlier resets are not shown.

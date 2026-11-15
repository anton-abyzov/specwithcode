# Subscriptions and resets

Open **Usage**, choose **Limits**, then **Subscriptions**. The view lists every subscription
signed in on your connected machines, so you can see which quota is about to reset unused.

## The dashboard

The page opens with a dashboard. One row of filters scopes everything under it:

- **Range**: 1W, 4W (the default), 12W or 1Y. The chart always draws twelve columns, weeks or months, so the range sits in context; columns before the range are dimmed.
- **Group by**: provider, account or machine. An account signed in on two machines is its own group ("m1 + m4"): a reset belongs to the account, so the app does not guess which machine spent the quota.

**Efficiency** is the share of the quota you planned to use that you did use before each reset, averaged over the range. Each reset counts once, or by its plan's monthly price when every account in the range has one. The score needs two resets in the range; before that it reads "Not enough history yet". When a reset in the range was last read more than two hours before it happened, the score reads "at least". The change against the span before is shown for weeks, not for 1Y, because the app keeps one year of resets.

A subscription you keep as a spare should not count against you. Group by account, click "plan 100%" on its row and set the share you plan to use, for example 30%. Using 30% of it then counts in full. The same form takes the monthly price.

Beside the score: what was left unused (with a token estimate where one can be measured), the quota that resets within 24 hours, and banked resets with the next expiry.

Point at a column, or move to it with the keyboard, to read each group's figure for that week; a week with a single reset says so. Click it to show only that week's resets in the table; "Show the whole range" goes back. The table lists ten resets a page, newest first. Click a row to open it: how long before the reset the app last read the account (a read more than two hours before makes the unused figure an upper bound, shown as "up to"), the planned share, the token estimate, the renewal date, where the account is signed in, and, for the last 14 days, the busiest day and use through the period against an even pace.

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

A token estimate appears only when no other account of that provider was read after the period began, so the
tokens behind its used percent can be measured. Otherwise the table says "Not measurable".

## How resets are recorded

Each machine records a reset when it reads a weekly or monthly window before and after it starts
over, and keeps the record for a year. Nothing is recorded when the app was not running for a
whole window, because the spend in that time is unknown. Records start from the version that
added this view; earlier resets are not shown.

## Reset announcements

Under the live rows, **Reset announcements** lists posts in which a provider reset limits for everyone, granted a banked reset, changed a limit or promised a reset: the date, the provider, the kind and a link to the post. Your main machine reads them every half hour from a public feed (airesets.dev) and keeps each post once. The request carries nothing about you. A confirmed post about a provider you have a subscription with raises one notification while it is under two days old, under the same conditions as the other warnings: the warnings are on, notifications are connected and the app is not in front. One machine sends it.

The list says when the feed's newest event is more than 14 days old, since the feed may have stopped. Turn the feed off under Settings > Models, "Read reset announcements"; the list then keeps what was already read.

If the feed goes quiet, a personal assistant can watch the posts itself: under its Routines, start **Reset announcement watch** from a template. It is off until you save it, runs on the assistant's provider at its everyday model, runs when you ask or every 2 hours if you choose that, and reads the listed staff and official accounts on X in your signed-in Chrome. Each post it finds is added to the same list, marked "Read by your routine, not verified"; it never posts, replies or follows, and answers "No new reset posts." when there is nothing new. Only posts by those accounts, or pages on the provider's own site, are kept, and nothing is kept while "Read reset announcements" is off. A recorded post raises no warning or notification and does not count toward the feed's 14-day note; when the feed later carries the same post, the feed's version replaces it.

## Warnings before quota resets unused

A banner above the project list says when a subscription is about to lose quota, the soonest loss first. It covers every subscription on the machines you are connected to, not only the one you are looking from, because you can start threads on any of them; each line names its machines. It warns of:

- a weekly or monthly window in its last two days that your pace so far will leave at least 40% unused, while there is still at least an hour to use it. Nothing used with two days to go warns; steady use that will finish the quota does not. A 5-hour window never warns: it refills within hours. Neither does a window that caps one model only;
- a banked reset in its last day;
- when the plan also renews within a day and that window ends with it, the same line says "renews in" instead; it is one warning, so dismissing either form holds;
- a limit the provider reset early, for six hours after it happened;
- a reset a provider promised for today, for a subscription of that provider with at least 40% left: "Codex Pro reset expected today: 62% left on m1 will be replaced", with a link to the post. It says "expected", because a promise is not a reset. The line goes when the window starts over or a day after the post. Dismissing it holds until that window resets, also for another promise posted in the meantime.

The banner shows the two soonest and counts the rest; a subscription takes one line. "See subscriptions" opens this page. The X dismisses the lines shown until the next reset of the windows they named. When the app is not in front and notifications are connected, each warning also raises one notification per period, on one machine: the first of the machines the account is signed in on.

### Use it until it resets

When the subscription in the first lines is signed in on your main machine on a plan, the banner offers **Use it for new worker threads until it resets**. Choose every project or tick the ones you want, then **Start**. Until that window resets, the setting names that subscription's regular model as the one new worker threads in those projects start on. Open threads and the project coordinator keep their model, and no saved default is changed, so there is nothing to restore. It covers worker threads an agent starts (delegated tasks and launched threads) that name no model of their own; routines, threads you start yourself in the composer, review tasks and a thread whose caller may not use that account keep their usual model.

It ends by itself at the window's reset: a boost past that time is not read at all. With the app open on any device it also ends when the provider resets the window early, when under 5% is left, or when that sign-in is turned off, signed out or moved to another account, and it follows a change of the provider's regular model. While it runs the banner reads "New worker threads use Codex Pro until 6:40 AM", also with the warnings turned off; **End now** stops it. It is not offered for a per-token key, a paid router, a model billed by the token, a banked reset, or an account signed in only on another machine.

An offline machine's reading is stale, so it raises no warning, and neither does an account you signed out of. The hosted app has no main machine to save a dismissal on, so it shows no banner. Turn the warnings off under Settings > Models, "Warn before quota resets unused"; the choice is saved on your main machine.

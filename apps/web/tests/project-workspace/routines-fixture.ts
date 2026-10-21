/* Routines the fixture host returns. `?personal&routines` is a personal
   assistant with reusable routines for a fictional household: no real person,
   account or folder. Without it, a code project's single daily review. */
const daily = { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] };

const household = [
  {
    id: "routine-tax-prep",
    projectId: "project",
    title: "Monthly tax prep",
    enabled: true,
    schedule: { type: "manual" },
    ownThread: true,
    threadId: "idle",
    lastRunAt: "2026-10-02T09:00:00Z",
    lastRunStatus: "succeeded",
    nextRunAt: null,
    brief: {
      inputs: [
        { label: "Receipts", location: "~/Example Household/receipts" },
        { label: "Statements", location: "~/Example Household/bank/{period}.csv" },
      ],
      output: "~/Example Household/tax/{period}-prep.md",
      prepareOnly: true,
    },
  },
  {
    id: "routine-pnl",
    projectId: "project",
    title: "Monthly profit and loss",
    enabled: true,
    schedule: { type: "monthly", dayOfMonth: 3, timeOfDay: "09:00" },
    ownThread: true,
    threadId: null,
    nextRunAt: "2026-11-03T09:00:00Z",
    brief: {
      inputs: [{ label: "Sales", location: "~/Example Studio/invoices" }],
      output: "~/Example Studio/reports/pnl-{period}.md",
      prepareOnly: true,
    },
  },
];

/* `?routines=coordinator`: a code project's coordinator routines, mostly paused,
   with a long name and a failed run, the way a busy project's Routines tab looks. */
const soon = new Date(Date.now() + 3 * 3_600_000).toISOString();
const watch = { type: "interval", everyMs: 30 * 60_000 };
const coordinatorRoutines = [
  {
    id: "routine-repair-watch",
    title: "Error-rate repair watch",
    enabled: true,
    schedule: watch,
    threadId: null,
    lastRunAt: new Date(Date.now() - 27 * 60_000).toISOString(),
    lastRunStatus: "succeeded",
    nextRunAt: soon,
  },
  {
    id: "routine-results",
    title: "Final matchday results",
    enabled: false,
    schedule: { type: "fixed_time", timeOfDay: "22:30", weekdays: [6, 0] },
    threadId: null,
    nextRunAt: null,
  },
  {
    id: "routine-release",
    title: "Watch the mobile club release",
    enabled: false,
    schedule: daily,
    threadId: null,
    lastRunAt: "2026-10-18T13:00:00Z",
    lastRunStatus: "failed",
    lastRunError: "The release check could not reach the store listing.",
    nextRunAt: null,
  },
  {
    id: "routine-clips",
    title:
      "Publish approved named highlight clips to every connected channel after the editor signs off on captions and thumbnails",
    enabled: false,
    schedule: { type: "monthly", dayOfMonth: 1, timeOfDay: "08:00" },
    threadId: null,
    nextRunAt: null,
  },
  {
    id: "routine-campaign",
    title: "Finish the approved analytics campaign",
    enabled: true,
    schedule: { type: "manual" },
    ownThread: true,
    threadId: "idle",
    nextRunAt: null,
  },
].map((task) => ({ projectId: "project", lastRunStatus: "never", ...task }));

/** The same routines as Settings > Routines lists them, with their prompts. */
export function managerRoutines(): ReadonlyArray<Record<string, unknown>> {
  return [
    ...coordinatorRoutines,
    {
      id: "routine-deploy-hook",
      projectId: "beacon",
      title: "Deploy preview on push",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      threadId: null,
      lastRunStatus: "succeeded",
      lastRunAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
      nextRunAt: null,
    },
  ].map((task) => ({
    prompt:
      "Check the latest state, fix what is broken in a worker thread and report back with the pull request, or say that nothing needed doing.",
    ...task,
  }));
}

export function routineTasks(): ReadonlyArray<Record<string, unknown>> {
  const search = new URLSearchParams(window.location.search);
  const own =
    search.has("personal") && search.has("routines")
      ? household
      : search.get("routines") === "coordinator"
        ? coordinatorRoutines
        : search.get("routines") === "none"
          ? []
          : [
              {
                id: "r1",
                projectId: "project",
                title: "Daily project review",
                enabled: true,
                schedule: daily,
                threadId: "idle",
                nextRunAt: "2026-10-10T13:00:00Z",
              },
            ];
  return [
    ...own,
    { id: "foreign", projectId: "other", title: "Foreign routine", enabled: true, schedule: daily },
  ];
}

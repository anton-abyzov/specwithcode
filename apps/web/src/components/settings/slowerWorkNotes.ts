/**
 * What adversarial review and the advisor cost in time, shown beside their
 * switches. Measured as active run time on one machine's threads, November
 * 14-18, 2026. Review: single-PR work took a median 2.6 times its active time
 * before the first review, counting review rounds and fixes (IQR 1.6-3.6, 43
 * threads, 140 reviews). Advisor: a consult runs a median 1.8 minutes; threads
 * that asked took a median 1.06 times as long, 1.14 pooled, 1.4 at the 90th
 * percentile (82 threads).
 */
/** The info button's name; `{setting}` is the switch's translated title. */
export const SLOWER_WORK_NOTE_LABEL = "How much longer work takes with {setting}";

export const ADVERSARIAL_REVIEW_TIME_NOTE =
  "Can make work take much longer to finish: in measured runs, reviewed work took a median 2.6 times as long as the same work before review (half of runs 1.6 to 3.6 times), because each review round and its fixes add time.";

export const ADVISOR_TIME_NOTE =
  "Can make work take longer: each consult adds about 2 minutes. In measured runs, threads that asked took about 1.1 times as long, and 1 in 10 took 1.4 times as long or more.";

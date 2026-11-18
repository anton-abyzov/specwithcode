/**
 * What adversarial review and the advisor cost in time, shown beside their
 * switches. Measured on one machine's threads, November 14-18, 2026:
 * single-PR work with review rounds took a median 2.6 times its active time
 * before the first review (IQR 1.6-3.6, 43 threads, 140 reviews); threads
 * that asked the advisor took a median 1.06 times as long, pooled 1.14,
 * 90th percentile 1.4 (82 threads, a consult runs about 2 minutes).
 */
export const SLOWER_WORK_NOTE_LABEL = "How much longer this takes";

export const ADVERSARIAL_REVIEW_TIME_NOTE =
  "Can make work take much longer to finish: about 2.6 times as long in measured runs, usually 1.5 to 3.5 times, because each review round and its fixes add time.";

export const ADVISOR_TIME_NOTE =
  "Can make work take longer: each consult adds about 2 minutes, so threads took about 1.1 times as long in measured runs, up to 1.4 times with many consults.";

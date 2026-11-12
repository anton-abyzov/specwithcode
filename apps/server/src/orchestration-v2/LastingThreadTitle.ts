/**
 * A thread's title names what the thread owns for as long as it lives. A
 * deadline or urgency copied from the first ask ("in 3 hours", "by Friday",
 * "ASAP") stops being true while the thread keeps working, so a title an
 * agent passes loses that tail. Only the end of the title is touched, and a
 * title that would be left with fewer than two words stays as written.
 */
const AMOUNT =
  "(?:\\d+(?:[.,]\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a\\s+few|a\\s+couple\\s+of|half\\s+an)";
const UNIT = "(?:h|hrs?|hours?|m|mins?|minutes?|days?|weeks?)";
const DAY =
  "(?:today|tonight|tomorrow|eod|eow|end\\s+of\\s+(?:the\\s+)?(?:day|week)|(?:the\\s+)?weekend|(?:this\\s+|next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))";

const TRAILING_TIME_WINDOWS: ReadonlyArray<RegExp> = [
  // "in 3 hours", "within the next 30 min", "in under an hour"
  new RegExp(
    `\\s+(?:with)?in\\s+(?:the\\s+next\\s+|under\\s+|less\\s+than\\s+)?${AMOUNT}[\\s-]*${UNIT}$`,
    "i",
  ),
  // "by Friday", "before tomorrow", "until 5pm"
  new RegExp(`\\s+(?:by|before|until)\\s+${DAY}$`, "i"),
  // "today", "this week", "ASAP"
  /\s+(?:today|tonight|tomorrow|asap|urgently|this\s+(?:morning|afternoon|evening|week))$/i,
];

const TRAILING_SEPARATOR = /[\s,;:(\-–—]+$/;

export function lastingThreadTitle(title: string): string {
  let result = title.trim().replace(/[.!]+$/, "");
  for (let pass = 0; pass < 3; pass += 1) {
    const before = result;
    for (const pattern of TRAILING_TIME_WINDOWS) {
      result = result.replace(pattern, "").replace(TRAILING_SEPARATOR, "");
    }
    if (result === before) break;
  }
  return result.split(/\s+/).filter(Boolean).length >= 2 ? result : title.trim();
}

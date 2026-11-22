import { format, isValid, startOfWeek } from "date-fns";

/** Monday of the Trial's week, as YYYY-MM-DD in the reader's time zone. */
export function weekOf(value: string | undefined): string {
  const date = new Date(value ?? "");
  if (!isValid(date)) return "unknown";
  return format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

/** Minimal, dependency-free CSV serializer for usage/feedback exports. */

/**
 * Escape one CSV cell, quoting delimiters, quotes, and line breaks while representing missing
 * values as empty cells.
 */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str: string;
  if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serialize rows in the supplied column order with escaped cells and CRLF records for CSV
 * downloads.
 */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(escapeCell).join(",");
  const lines = rows.map(/* Emit one row in the exact order used by the CSV header. */ (row) =>
    columns.map(/* Escape the current column value, including missing cells, before joining the record. */ (col) => escapeCell((row as Record<string, unknown>)[col])).join(",")
  );
  return [header, ...lines].join("\r\n");
}

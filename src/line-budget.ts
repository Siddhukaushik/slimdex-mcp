/** Format a bounded, numbered range and point to the first unread line. */
export function boundedLines(lines: string[], start: number, end: number, maxChars = 6000): { body: string; last: number; next?: number } {
  const s = Math.max(1, start);
  const e = Math.min(lines.length, Math.max(s, end));
  const rows: string[] = [];
  let size = 0;
  let last = s - 1;
  for (let line = s; line <= e; line++) {
    const row = `${String(line).padStart(5)}  ${lines[line - 1]}`;
    // Always include the first line so a single long line cannot stall paging.
    if (rows.length && size + row.length + 1 > maxChars) break;
    rows.push(row);
    size += row.length + (rows.length > 1 ? 1 : 0);
    last = line;
  }
  return { body: rows.join("\n"), last, ...(last < e ? { next: last + 1 } : {}) };
}

// ---------------------------------------------------------------------------
// Row-parsing utilities
// ---------------------------------------------------------------------------
// The `pg` driver returns NUMERIC / DECIMAL columns as strings to avoid
// JavaScript floating-point precision loss.  These helpers convert them to
// the appropriate JS primitive while preserving null semantics.

/** Parse a NUMERIC/DECIMAL column string to a JS number. */
export function toFloat(value: string): number {
  return parseFloat(value);
}

/** Parse a nullable NUMERIC column.  Returns null when the value is nullish. */
export function toFloatOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  return parseFloat(value);
}

/** Parse a BIGINT / large integer column string to a JS number.
 *  Use only when values are known to fit safely in Number (< 2^53). */
export function toInt(value: string): number {
  return parseInt(value, 10);
}

export function toIntOrNull(value: string | null | undefined): number | null {
  if (value == null) return null;
  return parseInt(value, 10);
}

/**
 * Build a parameterised VALUES list for a multi-row INSERT.
 *
 * @example
 *   const { text, values } = buildValuesList(rows, 4);
 *   // text  → "($1,$2,$3,$4),($5,$6,$7,$8)"
 *   // values → [row0col0, row0col1, ...]
 */
export function buildValuesList(
  rows: unknown[][],
  columnsPerRow: number,
): { text: string; values: unknown[] } {
  const placeholders: string[] = [];
  const values: unknown[] = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row === undefined || row.length !== columnsPerRow) {
      throw new Error(
        `buildValuesList: row ${r} has ${row?.length ?? 0} columns, expected ${columnsPerRow}`,
      );
    }
    const offset = r * columnsPerRow;
    const rowPlaceholders = row.map((_, c) => `$${offset + c + 1}`).join(",");
    placeholders.push(`(${rowPlaceholders})`);
    values.push(...row);
  }

  return { text: placeholders.join(","), values };
}

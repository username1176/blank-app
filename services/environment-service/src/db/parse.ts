// ---------------------------------------------------------------------------
// pg returns NUMERIC columns as strings — these helpers make the boundary explicit.
// ---------------------------------------------------------------------------

export function toFloat(value: string): number {
  return parseFloat(value);
}

export function toFloatOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return parseFloat(value);
}

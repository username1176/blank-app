// ---------------------------------------------------------------------------
// Typed database errors
// ---------------------------------------------------------------------------

export class DbError extends Error {
  constructor(
    message: string,
    public readonly pgCode?: string,
    public readonly detail?: string,
    public readonly constraint?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

export class UniqueConstraintError extends DbError {
  constructor(detail?: string, constraint?: string) {
    super("Unique constraint violation", "23505", detail, constraint);
    this.name = "UniqueConstraintError";
  }
}

export class ForeignKeyViolationError extends DbError {
  constructor(detail?: string, constraint?: string) {
    super("Foreign key violation", "23503", detail, constraint);
    this.name = "ForeignKeyViolationError";
  }
}

export class NotFoundError extends DbError {
  constructor(message = "Record not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapDbError(err: any): DbError {
  if (err instanceof DbError) return err;
  const code: string | undefined = err?.code;
  const detail: string | undefined = err?.detail;
  const constraint: string | undefined = err?.constraint;
  if (code === "23505") return new UniqueConstraintError(detail, constraint);
  if (code === "23503") return new ForeignKeyViolationError(detail, constraint);
  return new DbError(err?.message ?? String(err), code, detail, constraint);
}

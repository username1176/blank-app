// ---------------------------------------------------------------------------
// PostgreSQL error codes we handle explicitly
// https://www.postgresql.org/docs/current/errcodes-appendix.html
// ---------------------------------------------------------------------------

const PG_CODES = {
  UNIQUE_VIOLATION:            "23505",
  FOREIGN_KEY_VIOLATION:       "23503",
  NOT_NULL_VIOLATION:          "23502",
  CHECK_VIOLATION:             "23514",
  EXCLUSION_VIOLATION:         "23P01",
  QUERY_CANCELLED:             "57014",
  CONNECTION_FAILURE:          "08006",
  UNDEFINED_TABLE:             "42P01",
} as const;

// ---------------------------------------------------------------------------
// Base DB error
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

// ---------------------------------------------------------------------------
// Specific subtypes
// ---------------------------------------------------------------------------

export class UniqueConstraintError extends DbError {
  constructor(detail?: string, constraint?: string) {
    super(
      `Unique constraint violated${constraint ? `: ${constraint}` : ""}`,
      PG_CODES.UNIQUE_VIOLATION,
      detail,
      constraint,
    );
    this.name = "UniqueConstraintError";
  }
}

export class ForeignKeyViolationError extends DbError {
  constructor(detail?: string, constraint?: string) {
    super(
      `Foreign key violation${constraint ? `: ${constraint}` : ""}`,
      PG_CODES.FOREIGN_KEY_VIOLATION,
      detail,
      constraint,
    );
    this.name = "ForeignKeyViolationError";
  }
}

export class CheckViolationError extends DbError {
  constructor(detail?: string, constraint?: string) {
    super(
      `Check constraint violated${constraint ? `: ${constraint}` : ""}`,
      PG_CODES.CHECK_VIOLATION,
      detail,
      constraint,
    );
    this.name = "CheckViolationError";
  }
}

export class NotFoundError extends DbError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} not found: ${id}` : `${resource} not found`);
    this.name = "NotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Error mapper — converts raw pg errors to typed DbErrors
// ---------------------------------------------------------------------------

interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
  message: string;
}

function isPgError(err: unknown): err is PgError {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as Record<string, unknown>)["message"] === "string"
  );
}

export function mapDbError(err: unknown): DbError {
  if (!isPgError(err)) {
    return new DbError(String(err));
  }

  switch (err.code) {
    case PG_CODES.UNIQUE_VIOLATION:
      return new UniqueConstraintError(err.detail, err.constraint);

    case PG_CODES.FOREIGN_KEY_VIOLATION:
      return new ForeignKeyViolationError(err.detail, err.constraint);

    case PG_CODES.CHECK_VIOLATION:
      return new CheckViolationError(err.detail, err.constraint);

    default:
      return new DbError(err.message, err.code, err.detail, err.constraint);
  }
}

export type ErrorCode =
  | "NOT_FOUND"
  | "INVALID_ID"
  | "INVALID_QUERY"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "CONFLICT";

export interface ErrorDetail {
  field: string;
  issue?: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: ErrorDetail[];

  constructor(statusCode: number, code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(404, "NOT_FOUND", message);
  }

  static invalidId(message = "Invalid UUID format"): AppError {
    return new AppError(400, "INVALID_ID", message);
  }

  static invalidQuery(message: string, details?: ErrorDetail[]): AppError {
    return new AppError(400, "INVALID_QUERY", message, details);
  }

  static validationFailed(message: string, details?: ErrorDetail[]): AppError {
    return new AppError(422, "VALIDATION_FAILED", message, details);
  }

  static conflict(message: string): AppError {
    return new AppError(409, "CONFLICT", message);
  }

  static internal(message = "Internal server error"): AppError {
    return new AppError(500, "INTERNAL", message);
  }
}

import { ErrorCode, ErrorDetail } from "./errors.js";

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SuccessEnvelope<T> {
  data: T;
  meta?: PaginationMeta;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
  };
}

export function successEnvelope<T>(data: T, meta?: PaginationMeta): SuccessEnvelope<T> {
  if (meta !== undefined) {
    return { data, meta };
  }
  return { data };
}

export function errorEnvelope(code: ErrorCode, message: string, details?: ErrorDetail[]): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
    },
  };
}

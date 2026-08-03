export type ApiErrorCode =
  | "unauthorized"
  | "invalid_url"
  | "unsafe_url"
  | "duplicate_url"
  | "not_found"
  | "validation_error"
  | "llm_error";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
  [extra: string]: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message }, ...this.extra };
  }
}

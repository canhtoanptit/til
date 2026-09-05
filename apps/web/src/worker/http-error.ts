export type ApiErrorCode =
  | "unauthorized"
  // Sign-in itself failed (Google unreachable/unconfigured, bad state, or an
  // unverified account) — distinct from `unauthorized`, which means "you are
  // simply not signed in".
  | "auth_failed"
  | "invalid_url"
  | "unsafe_url"
  | "duplicate_url"
  | "not_found"
  | "validation_error"
  | "llm_error"
  | "workflow_error"
  | "chat_unavailable";

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

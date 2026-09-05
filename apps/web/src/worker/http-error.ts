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
  | "chat_unavailable"
  // The caller is signed in and the request is valid, but they have spent their
  // quota for the period — today only the daily entry cap (10/user/UTC-day).
  | "rate_limited";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
  [extra: string]: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly extra?: Record<string, unknown>;
  /**
   * Response headers the error itself requires — `Retry-After` on a 429, say.
   * They live on the error rather than at the throw site because the only code
   * that turns an HttpError into a Response is `app.ts`'s `onError`, far away
   * from wherever it was raised. Not part of `toBody()`: headers are transport,
   * the body is the API contract.
   */
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    extra?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message }, ...this.extra };
  }
}

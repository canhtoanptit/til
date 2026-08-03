import { ApiError } from "../api";

export function ErrorBanner({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message = friendlyMessage(error);
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "network_error":
        return "Network error — could not reach the server.";
      case "invalid_url":
        return "That URL doesn't look right.";
      case "unsafe_url":
        return "That URL is blocked for safety reasons.";
      case "duplicate_url":
        return "You already saved that link.";
      case "not_found":
        return "Not found.";
      case "validation_error":
        return error.message || "Some fields are invalid.";
      case "llm_error":
        return error.message || "The LLM call failed.";
      case "unauthorized":
        return "Your session expired — please sign in again.";
      default:
        return error.message || "Something went wrong.";
    }
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

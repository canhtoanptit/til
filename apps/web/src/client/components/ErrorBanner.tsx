import { ApiError } from "../api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ErrorBanner({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = friendlyMessage(error);
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive",
        className,
      )}
    >
      <p>{message}</p>
      {onRetry && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={onRetry}
        >
          Retry
        </Button>
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

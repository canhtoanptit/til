import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { cn } from "@/lib/utils";

export function HealthDot() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 30_000,
    retry: false,
  });
  const state = isLoading
    ? { color: "bg-muted-foreground/40", label: "checking" }
    : isError || !data?.ok
      ? { color: "bg-destructive", label: "api unreachable" }
      : { color: "bg-success", label: "api ok" };
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      title={state.label}
      aria-label={state.label}
    >
      <span
        aria-hidden="true"
        className={cn("inline-block size-2 rounded-full", state.color)}
      />
      <span className="hidden sm:inline">{state.label}</span>
    </span>
  );
}

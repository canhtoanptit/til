import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function HealthDot() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 30_000,
    retry: false,
  });
  const state = isLoading
    ? { color: "bg-slate-300", label: "checking" }
    : isError || !data?.ok
      ? { color: "bg-red-500", label: "api unreachable" }
      : { color: "bg-emerald-500", label: "api ok" };
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-slate-500"
      title={state.label}
      aria-label={state.label}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${state.color}`}
      />
      <span className="hidden sm:inline">{state.label}</span>
    </span>
  );
}

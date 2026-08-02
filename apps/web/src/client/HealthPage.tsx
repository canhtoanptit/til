import { useQuery } from "@tanstack/react-query";

interface HealthResponse {
  ok: boolean;
}

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`api ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export function HealthPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  const status = isLoading
    ? "loading"
    : isError
      ? "error"
      : data?.ok
        ? "ok"
        : "down";

  return (
    <main className="p-8">
      <h1>TIL</h1>
      <p>api: {status}</p>
    </main>
  );
}

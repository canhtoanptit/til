import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, type SettingsInput } from "../api";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";

interface FormState {
  provider: "openai" | "anthropic";
  model: string;
  apiKey: string;
  cfAccountId: string;
  cfGatewayId: string;
  cfAigToken: string;
}

const EMPTY_FORM: FormState = {
  provider: "openai",
  model: "",
  apiKey: "",
  cfAccountId: "",
  cfGatewayId: "",
  cfAigToken: "",
};

export function SettingsPage() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["settings"] as const,
    queryFn: ({ signal }) => api.getSettings(signal),
  });

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [maskedKey, setMaskedKey] = useState<string>("");
  const [hasAigToken, setHasAigToken] = useState(false);

  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setForm({
      provider: s.provider,
      model: s.model,
      apiKey: "",
      cfAccountId: s.cfAccountId,
      cfGatewayId: s.cfGatewayId,
      cfAigToken: "",
    });
    setMaskedKey(s.apiKeyMasked);
    setHasAigToken(s.hasAigToken);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: SettingsInput) => api.putSettings(input),
    onSuccess: (data) => {
      // Clear the sensitive inputs on success; masked value comes back from server.
      setForm((f) => ({ ...f, apiKey: "", cfAigToken: "" }));
      setMaskedKey(data.apiKeyMasked);
      setHasAigToken(data.hasAigToken);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.testSettings(),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.model.trim() || !form.apiKey.trim() || !form.cfAccountId.trim() || !form.cfGatewayId.trim()) {
      return;
    }
    const input: SettingsInput = {
      provider: form.provider,
      model: form.model.trim(),
      apiKey: form.apiKey,
      cfAccountId: form.cfAccountId.trim(),
      cfGatewayId: form.cfGatewayId.trim(),
    };
    const t = form.cfAigToken.trim();
    if (t) input.cfAigToken = t;
    saveMutation.mutate(input);
  }

  if (settingsQuery.isLoading) {
    return <Spinner label="Loading settings…" />;
  }
  if (settingsQuery.isError) {
    return (
      <ErrorBanner
        error={settingsQuery.error}
        onRetry={() => settingsQuery.refetch()}
      />
    );
  }

  const hasSaved = settingsQuery.data !== null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          BYOK — your provider API key is stored on the server. Saving requires
          re-entering the full key.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4 rounded border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <label htmlFor="provider" className="block text-sm font-medium text-slate-700">
            Provider
          </label>
          <select
            id="provider"
            value={form.provider}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                provider: e.target.value as "openai" | "anthropic",
              }))
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>

        <div>
          <label htmlFor="model" className="block text-sm font-medium text-slate-700">
            Model
          </label>
          <input
            id="model"
            type="text"
            required
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder={form.provider === "openai" ? "gpt-5-mini" : "claude-4-7-sonnet"}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="apiKey" className="block text-sm font-medium text-slate-700">
            API key
          </label>
          <input
            id="apiKey"
            type="password"
            required
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder={hasSaved ? maskedKey || "•••• saved" : "sk-…"}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
          {hasSaved && (
            <p className="mt-1 text-xs text-slate-500">
              A key is saved. Enter the full key to overwrite (partial updates aren't allowed).
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="cfAccountId"
              className="block text-sm font-medium text-slate-700"
            >
              CF account id
            </label>
            <input
              id="cfAccountId"
              type="text"
              required
              value={form.cfAccountId}
              onChange={(e) => setForm((f) => ({ ...f, cfAccountId: e.target.value }))}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="cfGatewayId"
              className="block text-sm font-medium text-slate-700"
            >
              CF gateway id
            </label>
            <input
              id="cfGatewayId"
              type="text"
              required
              value={form.cfGatewayId}
              onChange={(e) => setForm((f) => ({ ...f, cfGatewayId: e.target.value }))}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="cfAigToken"
            className="block text-sm font-medium text-slate-700"
          >
            AI gateway token (optional)
          </label>
          <input
            id="cfAigToken"
            type="password"
            autoComplete="off"
            value={form.cfAigToken}
            onChange={(e) => setForm((f) => ({ ...f, cfAigToken: e.target.value }))}
            placeholder={hasAigToken ? "•••• saved" : ""}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
          {hasAigToken && (
            <p className="mt-1 text-xs text-slate-500">
              A gateway token is saved. Leave blank to keep it; enter a value to overwrite.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saveMutation.isPending}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || !hasSaved}
            className="rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-50"
            title={hasSaved ? "" : "Save settings first"}
          >
            {testMutation.isPending ? "Testing…" : "Test connection"}
          </button>
        </div>

        {saveMutation.isError && (
          <p className="text-sm text-red-700">{friendlyMessage(saveMutation.error)}</p>
        )}
        {saveMutation.isSuccess && (
          <p className="text-sm text-emerald-700">Saved.</p>
        )}

        {testMutation.data && (
          <div
            role="status"
            className={`rounded-md p-3 text-sm ${
              testMutation.data.ok
                ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {testMutation.data.ok ? "Connection OK." : "Connection failed."}
            {testMutation.data.detail && (
              <span className="ml-1 italic">{testMutation.data.detail}</span>
            )}
          </div>
        )}
        {testMutation.isError && (
          <p className="text-sm text-red-700">{friendlyMessage(testMutation.error)}</p>
        )}
      </form>
    </div>
  );
}

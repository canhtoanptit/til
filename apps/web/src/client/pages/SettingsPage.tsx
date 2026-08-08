import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { api, type LLMProvider, type SettingsInput } from "../api";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";

interface FormState {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  cfAccountId: string;
  cfGatewayId: string;
  cfAigToken: string;
}

// Mirrors the server guard: the stored key may only be kept while these match.
interface SavedRouting {
  provider: LLMProvider;
  cfAccountId: string;
  cfGatewayId: string;
}

function providerPlaceholder(p: LLMProvider): string {
  if (p === "openai") return "gpt-5-mini";
  if (p === "anthropic") return "claude-4-7-sonnet";
  // WHY: llama-3.3-70b-versatile emits tool calls Groq's own validator rejects,
  // which breaks chat; gpt-oss handles both tool calling and strict json_schema.
  return "openai/gpt-oss-20b";
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
  const [savedRouting, setSavedRouting] = useState<SavedRouting | null>(null);
  const [clearAigToken, setClearAigToken] = useState(false);

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
    setSavedRouting({
      provider: s.provider,
      cfAccountId: s.cfAccountId,
      cfGatewayId: s.cfGatewayId,
    });
    setClearAigToken(false);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: SettingsInput) => api.putSettings(input),
    onSuccess: (data) => {
      // Clear the sensitive inputs on success; masked value comes back from server.
      setForm((f) => ({ ...f, apiKey: "", cfAigToken: "" }));
      setMaskedKey(data.apiKeyMasked);
      setHasAigToken(data.hasAigToken);
      setSavedRouting({
        provider: data.provider,
        cfAccountId: data.cfAccountId,
        cfGatewayId: data.cfGatewayId,
      });
      setClearAigToken(false);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.testSettings(),
  });

  const routingChanged =
    savedRouting !== null &&
    (savedRouting.provider !== form.provider ||
      savedRouting.cfAccountId !== form.cfAccountId.trim() ||
      savedRouting.cfGatewayId !== form.cfGatewayId.trim());
  const apiKeyRequired = savedRouting === null || routingChanged;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      !form.model.trim() ||
      !form.cfAccountId.trim() ||
      !form.cfGatewayId.trim()
    ) {
      return;
    }
    const apiKey = form.apiKey.trim();
    if (apiKeyRequired && !apiKey) {
      return;
    }
    const input: SettingsInput = {
      provider: form.provider,
      model: form.model.trim(),
      cfAccountId: form.cfAccountId.trim(),
      cfGatewayId: form.cfGatewayId.trim(),
    };
    if (apiKey) input.apiKey = apiKey;
    const t = form.cfAigToken.trim();
    // "" is the explicit clear signal; omit the field entirely to keep the stored token.
    if (clearAigToken) input.cfAigToken = "";
    else if (t) input.cfAigToken = t;
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

  const hasSaved = savedRouting !== null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">
          BYOK — your provider API key is stored on the server and is never sent
          back to the browser. Leave the key blank to keep the saved one.
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div>
          <label
            htmlFor="provider"
            className="block text-sm font-medium text-slate-700"
          >
            Provider
          </label>
          <select
            id="provider"
            value={form.provider}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                provider: e.target.value as LLMProvider,
              }))
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="groq">Groq</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="model"
            className="block text-sm font-medium text-slate-700"
          >
            Model
          </label>
          <input
            id="model"
            type="text"
            required
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            placeholder={providerPlaceholder(form.provider)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="apiKey"
            className="block text-sm font-medium text-slate-700"
          >
            API key{hasSaved && !apiKeyRequired ? " (optional)" : ""}
          </label>
          <input
            id="apiKey"
            type="password"
            required={apiKeyRequired}
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder={hasSaved ? maskedKey || "•••• saved" : "sk-…"}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
          {hasSaved && (
            <p className="mt-1 text-xs text-slate-500">
              Leave blank to keep the saved key. Required if you change
              provider, account ID, or gateway ID.
            </p>
          )}
          {routingChanged && (
            <p className="mt-1 text-xs text-amber-700">
              Provider, account ID, or gateway ID changed — re-enter the full
              API key to save.
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
              onChange={(e) =>
                setForm((f) => ({ ...f, cfAccountId: e.target.value }))
              }
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
              onChange={(e) =>
                setForm((f) => ({ ...f, cfGatewayId: e.target.value }))
              }
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="cfAigToken"
            className="block text-sm font-medium text-slate-700"
          >
            AI Gateway token (<code>cf-aig-authorization</code>)
          </label>
          <input
            id="cfAigToken"
            type="password"
            autoComplete="off"
            disabled={clearAigToken}
            value={form.cfAigToken}
            onChange={(e) =>
              setForm((f) => ({ ...f, cfAigToken: e.target.value }))
            }
            placeholder={hasAigToken ? "•••• saved" : "gateway token"}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400"
          />
          <p className="mt-1 text-xs text-slate-500">
            Required if your gateway has Authenticated Gateway enabled. Leave
            blank to keep the saved token.
          </p>
          {hasAigToken && (
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={clearAigToken}
                onChange={(e) => {
                  setClearAigToken(e.target.checked);
                  if (e.target.checked)
                    setForm((f) => ({ ...f, cfAigToken: "" }));
                }}
                className="rounded border-slate-300"
              />
              Clear saved token (save to remove it)
            </label>
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
          <p className="text-sm text-red-700">
            {friendlyMessage(saveMutation.error)}
          </p>
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
          <p className="text-sm text-red-700">
            {friendlyMessage(testMutation.error)}
          </p>
        )}
      </form>
    </div>
  );
}

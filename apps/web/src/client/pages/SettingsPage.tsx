import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api, type LLMProvider, type SettingsInput } from "../api";
import { BookmarkletCard } from "../components/BookmarkletCard";
import { DigestSourcesCard } from "../components/DigestSourcesCard";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
      toast.success("Settings saved");
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
    onError: (e) => {
      toast.error("Could not save settings", { description: friendlyMessage(e) });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.testSettings(),
    onSuccess: (result) => {
      // A reachable server that rejects the credentials is still a failed test,
      // so the toast follows `result.ok`, not the HTTP outcome.
      if (result.ok) {
        toast.success("Connection OK", { description: result.detail });
      } else {
        toast.error("Connection failed", { description: result.detail });
      }
    },
    onError: (e) => {
      toast.error("Could not test the connection", {
        description: friendlyMessage(e),
      });
    },
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

  // WHY the extras repeat in every branch: digest sources and the bookmarklet do
  // not depend on the LLM settings query, so a slow or failing GET /api/settings
  // must not take the rest of the page down with it.
  if (settingsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Spinner label="Loading settings…" />
        <SettingsExtras />
      </div>
    );
  }
  if (settingsQuery.isError) {
    return (
      <div className="space-y-6">
        <ErrorBanner
          error={settingsQuery.error}
          onRetry={() => settingsQuery.refetch()}
        />
        <SettingsExtras />
      </div>
    );
  }

  const hasSaved = savedRouting !== null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          BYOK — your provider API key is stored on the server and is never sent
          back to the browser. Leave the key blank to keep the saved one.
        </p>
      </header>

      <Card>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={form.provider}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, provider: v as LLMProvider }))
                }
              >
                <SelectTrigger id="provider" className="mt-1 w-full">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="groq">Groq</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                type="text"
                required
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder={providerPlaceholder(form.provider)}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="apiKey">
                API key{hasSaved && !apiKeyRequired ? " (optional)" : ""}
              </Label>
              <Input
                id="apiKey"
                type="password"
                required={apiKeyRequired}
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder={hasSaved ? maskedKey || "•••• saved" : "sk-…"}
                className="mt-1"
              />
              {hasSaved && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave blank to keep the saved key. Required if you change
                  provider, account ID, or gateway ID.
                </p>
              )}
              {routingChanged && (
                <p className="mt-1 text-xs text-warning">
                  Provider, account ID, or gateway ID changed — re-enter the full
                  API key to save.
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="cfAccountId">CF account id</Label>
                <Input
                  id="cfAccountId"
                  type="text"
                  required
                  value={form.cfAccountId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, cfAccountId: e.target.value }))
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="cfGatewayId">CF gateway id</Label>
                <Input
                  id="cfGatewayId"
                  type="text"
                  required
                  value={form.cfGatewayId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, cfGatewayId: e.target.value }))
                  }
                  className="mt-1"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="cfAigToken">
                AI Gateway token (<code>cf-aig-authorization</code>)
              </Label>
              <Input
                id="cfAigToken"
                type="password"
                autoComplete="off"
                disabled={clearAigToken}
                value={form.cfAigToken}
                onChange={(e) =>
                  setForm((f) => ({ ...f, cfAigToken: e.target.value }))
                }
                placeholder={hasAigToken ? "•••• saved" : "gateway token"}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Required if your gateway has Authenticated Gateway enabled. Leave
                blank to keep the saved token.
              </p>
              {hasAigToken && (
                <Label
                  htmlFor="clearAigToken"
                  className="mt-2 text-xs font-normal text-muted-foreground"
                >
                  <input
                    id="clearAigToken"
                    type="checkbox"
                    checked={clearAigToken}
                    onChange={(e) => {
                      setClearAigToken(e.target.checked);
                      if (e.target.checked)
                        setForm((f) => ({ ...f, cfAigToken: "" }));
                    }}
                    className="size-3.5 rounded border-input accent-primary"
                  />
                  Clear saved token (save to remove it)
                </Label>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending || !hasSaved}
                title={hasSaved ? "" : "Save settings first"}
              >
                {testMutation.isPending ? "Testing…" : "Test connection"}
              </Button>
            </div>

            {testMutation.data && (
              <div
                role="status"
                className={
                  testMutation.data.ok
                    ? "rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success"
                    : "rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                }
              >
                {testMutation.data.ok ? "Connection OK." : "Connection failed."}
                {testMutation.data.detail && (
                  <span className="ml-1 italic">{testMutation.data.detail}</span>
                )}
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      <SettingsExtras />
    </div>
  );
}

function SettingsExtras() {
  return (
    <>
      <DigestSourcesCard />
      <BookmarkletCard />
    </>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  FileTextIcon,
  GraduationCapIcon,
  LayersIcon,
  MessagesSquareIcon,
  SettingsIcon,
  TagsIcon,
} from "lucide-react";
import { api } from "../api";
import { friendlyMessage } from "./ErrorBanner";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

// Every page in the Shell nav, in the same order, so the palette is never a
// shorter menu than the header. `/review` had been missing since it shipped.
const NAV_ITEMS = [
  { to: "/", label: "Go to Feed", icon: LayersIcon },
  { to: "/tags", label: "Go to Tags", icon: TagsIcon },
  { to: "/review", label: "Go to Review", icon: GraduationCapIcon },
  { to: "/chat", label: "Go to Chat", icon: MessagesSquareIcon },
  { to: "/digests", label: "Go to Digests", icon: FileTextIcon },
  { to: "/settings", label: "Go to Settings", icon: SettingsIcon },
] as const;

/** Opens the palette on Cmd+K / Ctrl+K anywhere in the app. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "k" && e.key !== "K") return;
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { open, setOpen };
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Reset between openings so a stale query never greets the next open.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  const search = useQuery({
    queryKey: ["search", debouncedQuery] as const,
    queryFn: ({ signal }) => api.search(debouncedQuery, signal),
    enabled: open && debouncedQuery.length > 0,
  });

  const entries = search.data?.items ?? [];
  const searching = debouncedQuery.length > 0;

  function go(to: string) {
    onOpenChange(false);
    void navigate(to);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search your saved entries or jump to a page."
      // Results come ranked from the hybrid search endpoint; cmdk's client-side
      // fuzzy filter would drop rows that matched semantically but not lexically.
      shouldFilter={!searching}
    >
      <CommandInput
        placeholder="Search your saved entries…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {!searching && (
          <CommandGroup heading="Navigate">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <CommandItem key={to} value={label} onSelect={() => go(to)}>
                <Icon />
                <span>{label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {searching && search.isPending && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Searching…
          </div>
        )}

        {searching && search.isError && (
          <div
            role="alert"
            className="py-6 text-center text-sm text-destructive"
          >
            {friendlyMessage(search.error)}
          </div>
        )}

        {searching && search.isSuccess && entries.length === 0 && (
          <CommandEmpty>No entries match "{debouncedQuery}".</CommandEmpty>
        )}

        {searching && entries.length > 0 && (
          <>
            <CommandGroup heading="Entries">
              {entries.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  onSelect={() =>
                    go(`/entries/${encodeURIComponent(entry.id)}`)
                  }
                >
                  <FileTextIcon />
                  <span className="truncate">
                    {entry.title?.trim() || entry.canonicalUrl}
                  </span>
                  {entry.sourceDomain && (
                    <CommandShortcut>{entry.sourceDomain}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

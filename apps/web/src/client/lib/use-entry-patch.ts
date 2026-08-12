import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type EntryDetailDTO } from "../api";
import { friendlyMessage } from "../components/ErrorBanner";
import { TAGS_KEY, type EntryPatchVars } from "./entry-marks";

/**
 * The one mutation behind every favorite / archive / note affordance in the app.
 *
 * Not optimistic on purpose: the response is the authoritative row, so it is
 * written straight into the detail cache, and the list caches are invalidated
 * rather than patched — a star click can move an entry *out* of the view it was
 * clicked in (favoriting from the Archived chip, archiving from the feed), which
 * is a re-query, not an in-place edit. Tag counts move with archiving, so
 * `["tags"]` goes stale too.
 */
export function useEntryPatch() {
  const qc = useQueryClient();
  return useMutation<EntryDetailDTO, unknown, EntryPatchVars>({
    mutationFn: ({ id, patch }) => api.updateEntry(id, patch),
    onSuccess: (entry, vars) => {
      toast.success(vars.success);
      // PATCH answers with the detail shape, so this cannot drop contentMarkdown.
      qc.setQueryData(["entry", entry.id], entry);
      void qc.invalidateQueries({ queryKey: ["entries"] });
      void qc.invalidateQueries({ queryKey: TAGS_KEY });
    },
    onError: (error, vars) => {
      toast.error(vars.failure, { description: friendlyMessage(error) });
    },
  });
}

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api";
import { exportFormatLabel, saveBlob, type ExportFormat } from "../export-file";
import { friendlyMessage } from "./ErrorBanner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function ExportBackupCard() {
  const exportMutation = useMutation({
    mutationFn: (format: ExportFormat) => api.exportBackup(format),
    onSuccess: (file) => {
      saveBlob(file.blob, file.filename);
      toast.success("Export ready", { description: file.filename });
    },
    onError: (e) => {
      toast.error("Could not build the export", {
        description: friendlyMessage(e),
      });
    },
  });

  // One mutation for both buttons, so `variables` is what says which one is busy —
  // and only one export can be in flight, which is what you want for something
  // that reads the whole library.
  const pending = (format: ExportFormat) =>
    exportMutation.isPending && exportMutation.variables === format;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export &amp; backup</CardTitle>
        <CardDescription>
          Take your reading with you. The JSON backup is everything: entries
          with their full text, digests, review schedules, feeds and feedback.
          The markdown bundle is one readable document — entries and digests
          only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={() => exportMutation.mutate("json")}
            disabled={exportMutation.isPending}
          >
            {pending("json") ? "Preparing…" : "Download JSON backup"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => exportMutation.mutate("markdown")}
            disabled={exportMutation.isPending}
          >
            {pending("markdown") ? "Preparing…" : "Download markdown bundle"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Your provider API key is <strong>deliberately not included</strong> —
          a backup sitting in a downloads folder must not also be a copy of a
          secret, so re-enter the key after a restore. Embedding vectors are
          left out too: they are recomputable from the entries, and they would
          dwarf the text. Chat transcripts live outside this database and are
          not part of an export.
        </p>
        {exportMutation.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            Building your{" "}
            {exportFormatLabel(exportMutation.variables ?? "json")}. A large
            library can take a moment.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

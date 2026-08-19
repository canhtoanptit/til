import { useState } from "react";
import { toast } from "sonner";
import { bookmarkletHref } from "@/lib/bookmarklet";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * The "Save to TIL" bookmarklet (C16). Rendered as copyable text rather than a
 * drag-me anchor because React refuses to render a `javascript:` href, and
 * pasting it into a new bookmark is the flow that works in every browser.
 */
export function BookmarkletCard() {
  const [copied, setCopied] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const snippet = bookmarkletHref(origin);

  async function copy(): Promise<void> {
    if (snippet === null) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success("Bookmarklet copied", {
        description: "Paste it as the URL of a new bookmark.",
      });
    } catch {
      // Clipboard access is denied outside a secure context, and in some
      // browsers' private modes — the snippet is on screen, so say so.
      toast.error("Could not copy to the clipboard", {
        description: "Select the snippet below and copy it manually.",
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Save from anywhere</CardTitle>
        <CardDescription>
          A bookmarklet that sends the page you are reading to your feed. It
          carries no credentials — it only opens this app with the page URL, and
          your saved token in this browser is what authorises the save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {snippet === null ? (
          <p className="text-sm text-muted-foreground">
            The bookmarklet is unavailable on this origin.
          </p>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Copy the snippet below.</li>
              <li>
                Add a new bookmark in your browser, name it{" "}
                <span className="font-medium text-foreground">Save to TIL</span>
                .
              </li>
              <li>Paste the snippet as the bookmark's URL.</li>
            </ol>
            <code className="block max-h-32 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs break-all">
              {snippet}
            </code>
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {copied ? "Copied — copy again" : "Copy bookmarklet"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

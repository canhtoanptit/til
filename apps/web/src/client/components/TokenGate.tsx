import { useState, type FormEvent } from "react";
import { setToken } from "../api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TokenGate() {
  const [value, setValue] = useState("");
  const [showHint, setShowHint] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setToken(trimmed);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm gap-4">
        <CardHeader>
          <CardTitle className="text-lg">TIL</CardTitle>
          <CardDescription>Enter your app token to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <Label htmlFor="til-token">App token</Label>
            <Input
              id="til-token"
              name="token"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1"
              aria-describedby="til-token-hint"
            />
            <Button
              type="button"
              variant="link"
              size="xs"
              className="mt-2 px-0"
              onClick={() => setShowHint((s) => !s)}
            >
              {showHint ? "hide hint" : "hint"}
            </Button>
            {showHint && (
              <p id="til-token-hint" className="mt-1 text-xs text-muted-foreground">
                Local dev token is{" "}
                <code className="rounded bg-muted px-1">dev-token</code>.
              </p>
            )}
            <Button type="submit" disabled={!value.trim()} className="mt-4 w-full">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

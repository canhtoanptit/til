import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { ChatToolPart } from "./ChatToolPart";
import { toolNameOfPart, type ChatUIPart } from "./chat-format";
import { voteButtonLabel, voteConfirmation } from "./chat-feedback";
import { Button } from "@/components/ui/button";
import type { FeedbackKind } from "../api";

export interface ChatMessageLike {
  id: string;
  role: string;
  parts: readonly ChatUIPart[];
}

/** Supplied only for turns the page considers votable; omit it and the controls
 * are simply absent, which is what user turns and in-flight turns want. */
export interface MessageFeedback {
  recorded: FeedbackKind | null;
  pending: FeedbackKind | null;
  onVote: (kind: FeedbackKind) => void;
}

export function ChatMessageView({
  message,
  feedback,
}: {
  message: ChatMessageLike;
  feedback?: MessageFeedback | undefined;
}) {
  if (message.role === "user") {
    const text = textOf(message.parts);
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
          {text}
        </p>
      </div>
    );
  }

  // A turn that failed before producing anything would otherwise leave a blank
  // block in the transcript.
  const renderable = message.parts.filter(isRenderable);
  if (renderable.length === 0) return null;

  return (
    <div className="space-y-2">
      {renderable.map((part, index) => (
        <PartView key={`${message.id}-${index}`} part={part} />
      ))}
      {feedback && <FeedbackControls feedback={feedback} />}
    </div>
  );
}

/**
 * Two low-contrast thumbs under a finished answer. They stay dim until hovered,
 * focused or voted on, so the transcript still reads as prose.
 */
function FeedbackControls({ feedback }: { feedback: MessageFeedback }) {
  const { recorded, pending } = feedback;
  return (
    <div className="flex items-center gap-1 pt-0.5">
      {(["up", "down"] as const).map((kind) => {
        const isRecorded = recorded === kind;
        return (
          <Button
            key={kind}
            type="button"
            variant="ghost"
            size="icon-xs"
            // aria-pressed carries the recorded state for assistive tech; the
            // colour change carries it for everyone else.
            aria-pressed={isRecorded}
            aria-label={voteButtonLabel(kind)}
            title={voteButtonLabel(kind)}
            disabled={pending !== null}
            onClick={() => feedback.onVote(kind)}
            className={
              isRecorded
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground focus-visible:text-foreground"
            }
          >
            {kind === "up" ? (
              <ThumbsUpIcon aria-hidden="true" />
            ) : (
              <ThumbsDownIcon aria-hidden="true" />
            )}
          </Button>
        );
      })}
      {/* A toast per vote would be noise, so the confirmation lives here. It is
          only ever rendered after the POST succeeded. */}
      {recorded !== null && (
        <span className="text-[11px] text-muted-foreground">
          {voteConfirmation(recorded)}
        </span>
      )}
    </div>
  );
}

function isRenderable(part: ChatUIPart): boolean {
  if (part.type === "text") return part.text.length > 0;
  return toolNameOfPart(part) !== null;
}

function PartView({ part }: { part: ChatUIPart }) {
  if (part.type === "text") {
    if (part.text.length === 0) return null;
    return (
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {part.text}
      </p>
    );
  }
  const tool = toolNameOfPart(part);
  if (tool !== null) return <ChatToolPart part={part} tool={tool} />;
  return null;
}

function textOf(parts: readonly ChatUIPart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text.length > 0) chunks.push(part.text);
  }
  return chunks.join("\n");
}

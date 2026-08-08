import { ChatToolPart } from "./ChatToolPart";
import { toolNameOfPart, type ChatUIPart } from "./chat-format";

export interface ChatMessageLike {
  id: string;
  role: string;
  parts: readonly ChatUIPart[];
}

export function ChatMessageView({ message }: { message: ChatMessageLike }) {
  if (message.role === "user") {
    const text = textOf(message.parts);
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-slate-900 px-4 py-2 text-sm text-white">
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
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
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

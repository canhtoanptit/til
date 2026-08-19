// See src/client/pages/ReviewPage.test.tsx for the client-test pattern.
//
// Two layers in one file: `ChatMessageView` on its own (what the thumbs look
// like given a feedback prop), and the real ChatPage wiring around it (when the
// prop is supplied at all, and what a click actually posts). The wiring is the
// half that has been regressing, and it only exists in ChatPage — so the chat
// transport hooks are stubbed rather than the wiring reimplemented in a harness.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ApiError, type FeedbackKind } from "../api";
import { renderWithProviders } from "../test-utils";
import { ChatMessageView, type ChatMessageLike } from "./ChatMessageView";

const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn(),
  listChats: vi.fn(),
  getEntry: vi.fn(),
  deleteChat: vi.fn(),
  mintChatTicket: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  chatState: {
    messages: [] as ChatMessageLike[],
    isStreaming: false,
    isRecovering: false,
    status: "ready" as string,
    error: undefined as unknown,
    connectionError: null as unknown,
  },
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      submitFeedback: mocks.submitFeedback,
      listChats: mocks.listChats,
      getEntry: mocks.getEntry,
      deleteChat: mocks.deleteChat,
      mintChatTicket: mocks.mintChatTicket,
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

// The transport, and only the transport. `useAgent` opens a WebSocket and
// `useAgentChat` resolves the stored transcript with React `use()`; neither can
// run here, and neither is what these tests are about.
vi.mock("agents/react", () => ({ useAgent: () => ({}) }));

vi.mock("@cloudflare/ai-chat/react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cloudflare/ai-chat/react")>();
  return {
    ...actual,
    useAgentChat: () => ({
      ...mocks.chatState,
      sendMessage: vi.fn(),
      clearError: vi.fn(),
      stop: vi.fn(),
    }),
  };
});

// Imported after the mock declarations for readability only — vi.mock is hoisted.
const { ChatPage } = await import("../pages/ChatPage");

function assistant(id: string, text: string): ChatMessageLike {
  return { id, role: "assistant", parts: [{ type: "text", text } as never] };
}

function user(id: string, text: string): ChatMessageLike {
  return { id, role: "user", parts: [{ type: "text", text } as never] };
}

const UP = "Mark this answer helpful";
const DOWN = "Mark this answer unhelpful";

function renderChat(
  messages: ChatMessageLike[],
  over: { busy?: boolean } = {},
) {
  mocks.chatState.messages = messages;
  mocks.chatState.isStreaming = over.busy ?? false;
  mocks.chatState.status = (over.busy ?? false) ? "streaming" : "ready";
  return renderWithProviders(
    <Routes>
      <Route path="/chat/:id" element={<ChatPage />} />
    </Routes>,
    { route: "/chat/c1" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listChats.mockResolvedValue({ items: [] });
  mocks.submitFeedback.mockResolvedValue({
    id: "f1",
    conversationId: "c1",
    messageId: "m1",
    entryId: null,
    kind: "up" as FeedbackKind,
    comment: null,
    createdAt: 0,
  });
  mocks.chatState.error = undefined;
  mocks.chatState.connectionError = null;
  mocks.chatState.isRecovering = false;
});

describe("ChatMessageView thumbs", () => {
  it("renders no controls when no feedback prop is supplied", () => {
    renderWithProviders(
      <ChatMessageView message={assistant("m1", "Because of X.")} />,
    );
    expect(screen.getByText("Because of X.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: UP })).toBeNull();
  });

  it("shows the recorded vote as pressed, with an inline confirmation", () => {
    renderWithProviders(
      <ChatMessageView
        message={assistant("m1", "Because of X.")}
        feedback={{ recorded: "down", pending: null, onVote: vi.fn() }}
      />,
    );
    expect(
      screen.getByRole("button", { name: DOWN }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: UP }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByText("Noted as unhelpful")).toBeTruthy();
  });

  it("disables both thumbs while a vote is in flight", () => {
    renderWithProviders(
      <ChatMessageView
        message={assistant("m1", "Because of X.")}
        feedback={{ recorded: null, pending: "up", onVote: vi.fn() }}
      />,
    );
    expect(
      (screen.getByRole("button", { name: UP }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: DOWN }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Nothing is claimed until the POST comes back.
    expect(screen.queryByText("Noted as helpful")).toBeNull();
  });

  it("renders nothing at all for an assistant turn with no renderable parts", () => {
    renderWithProviders(
      <ChatMessageView
        message={{ id: "m1", role: "assistant", parts: [] }}
        feedback={{ recorded: null, pending: null, onVote: vi.fn() }}
      />,
    );
    // A turn that failed before producing anything must not leave a blank block
    // with a pair of thumbs under it.
    expect(screen.queryByRole("button", { name: UP })).toBeNull();
    expect(screen.queryByRole("button", { name: DOWN })).toBeNull();
  });

  it("drops empty text parts rather than rendering blank paragraphs", () => {
    renderWithProviders(
      <ChatMessageView
        message={{
          id: "m1",
          role: "assistant",
          parts: [
            { type: "text", text: "" } as never,
            { type: "text", text: "Real content." } as never,
          ],
        }}
      />,
    );
    expect(screen.getAllByText(/./, { selector: "p" })).toHaveLength(1);
    expect(screen.getByText("Real content.")).toBeTruthy();
  });
});

describe("chat feedback wiring", () => {
  it("offers thumbs on completed assistant turns only", async () => {
    renderChat([user("m1", "why?"), assistant("m2", "Because of X.")]);

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: UP })).toHaveLength(1),
    );
    // The user's own turn is not votable, so there is exactly one pair.
    expect(screen.getAllByRole("button", { name: DOWN })).toHaveLength(1);
  });

  it("withholds the thumbs on the last turn while it is still streaming", async () => {
    renderChat([user("m1", "why?"), assistant("m2", "Because of")], {
      busy: true,
    });

    await waitFor(() => expect(screen.getByText("Because of")).toBeTruthy());
    // Voting here would rate a half-written answer.
    expect(screen.queryByRole("button", { name: UP })).toBeNull();
  });

  it("still offers thumbs on earlier turns while a new one streams", async () => {
    renderChat(
      [
        user("m1", "why?"),
        assistant("m2", "Because of X."),
        user("m3", "and?"),
        assistant("m4", "Well"),
      ],
      { busy: true },
    );

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: UP })).toHaveLength(1),
    );
  });

  it("posts the vote and lights the thumb only once the POST succeeds", async () => {
    let release: (() => void) | undefined;
    mocks.submitFeedback.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ id: "f1" }))),
    );
    const u = userEvent.setup();
    renderChat([assistant("m2", "Because of X.")]);

    const up = await screen.findByRole("button", { name: UP });
    await u.click(up);

    expect(mocks.submitFeedback).toHaveBeenCalledWith({
      conversationId: "c1",
      messageId: "m2",
      kind: "up",
    });
    // In flight: no claim yet.
    expect(screen.queryByText("Noted as helpful")).toBeNull();
    expect(
      screen.getByRole("button", { name: UP }).getAttribute("aria-pressed"),
    ).toBe("false");

    release?.();
    expect(await screen.findByText("Noted as helpful")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: UP }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("leaves the thumb untouched and toasts when the POST fails", async () => {
    mocks.submitFeedback.mockRejectedValue(
      new ApiError("network_error", "offline", 0),
    );
    const u = userEvent.setup();
    renderChat([assistant("m2", "Because of X.")]);

    await u.click(await screen.findByRole("button", { name: UP }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not record that feedback",
        { description: "Network error — could not reach the server." },
      ),
    );
    expect(screen.queryByText("Noted as helpful")).toBeNull();
    expect(
      screen.getByRole("button", { name: UP }).getAttribute("aria-pressed"),
    ).toBe("false");
    // And it is retryable — the failure released the pending lock.
    expect(
      (screen.getByRole("button", { name: UP }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("posts a correction when the opposite thumb is clicked", async () => {
    const u = userEvent.setup();
    renderChat([assistant("m2", "Because of X.")]);

    await u.click(await screen.findByRole("button", { name: UP }));
    expect(await screen.findByText("Noted as helpful")).toBeTruthy();

    await u.click(screen.getByRole("button", { name: DOWN }));

    await waitFor(() =>
      expect(mocks.submitFeedback).toHaveBeenLastCalledWith({
        conversationId: "c1",
        messageId: "m2",
        kind: "down",
      }),
    );
    expect(await screen.findByText("Noted as unhelpful")).toBeTruthy();
    expect(screen.queryByText("Noted as helpful")).toBeNull();
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(2);
  });

  it("does not re-post a vote that is already recorded", async () => {
    const u = userEvent.setup();
    renderChat([assistant("m2", "Because of X.")]);

    await u.click(await screen.findByRole("button", { name: UP }));
    expect(await screen.findByText("Noted as helpful")).toBeTruthy();

    await u.click(screen.getByRole("button", { name: UP }));

    // The log is append-only; a duplicate row would mean nothing new.
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
  });

  it("keeps votes independent per turn", async () => {
    const u = userEvent.setup();
    renderChat([assistant("m2", "First answer."), assistant("m3", "Second.")]);

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: UP })).toHaveLength(2),
    );
    const [firstUp] = screen.getAllByRole("button", { name: UP });
    await u.click(firstUp as HTMLElement);

    expect(await screen.findByText("Noted as helpful")).toBeTruthy();
    expect(mocks.submitFeedback).toHaveBeenCalledWith({
      conversationId: "c1",
      messageId: "m2",
      kind: "up",
    });
    // Only one turn is marked.
    expect(screen.getAllByText("Noted as helpful")).toHaveLength(1);
  });
});

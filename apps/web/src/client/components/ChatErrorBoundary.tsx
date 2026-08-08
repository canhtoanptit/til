import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorBanner } from "./ErrorBanner";

interface Props {
  children: ReactNode;
  onReset: () => void;
}

interface State {
  error: unknown;
}

/**
 * The chat hooks resolve the auth ticket and the stored transcript with React
 * `use()`, so a rejected promise surfaces as a render-time throw. Without this
 * the whole route would go blank — the one failure mode the chat page must not
 * have.
 */
export class ChatErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[chat] render failed:", error, info.componentStack);
  }

  private readonly reset = () => {
    this.setState({ error: null });
    this.props.onReset();
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <ErrorBanner error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}

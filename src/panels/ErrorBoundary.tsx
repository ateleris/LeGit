import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("LeGit render error:", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          padding: 32,
          fontFamily: "monospace",
          color: "var(--error-fg, #f87171)",
        }}>
          <div style={{ fontSize: "var(--fz-xl)", fontWeight: 600, marginBottom: 12 }}>
            Something went wrong
          </div>
          <pre style={{
            maxWidth: 640,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: "var(--fz-md)",
            color: "var(--subtle-fg, #a1a1a1)",
          }}>
            {this.state.error.message}
          </pre>
          <button
            style={{ marginTop: 20 }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

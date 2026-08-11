import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

interface AppRuntimeBoundaryState {
  hasError: boolean;
  message: string;
}

class AppRuntimeBoundary extends React.Component<
  React.PropsWithChildren,
  AppRuntimeBoundaryState
> {
  public state: AppRuntimeBoundaryState = {
    hasError: false,
    message: "",
  };

  public static getDerivedStateFromError(
    error: Error,
  ): AppRuntimeBoundaryState {
    return {
      hasError: true,
      message: error.message || "应用运行时发生错误。",
    };
  }

  public componentDidCatch(error: Error): void {
    console.error("App runtime error:", error);
  }

  public render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            width: "100vw",
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            background: "#f6f4ef",
            color: "#1b2430",
            padding: 24,
            textAlign: "center",
          }}
        >
          <strong>界面渲染失败</strong>
          <div>{this.state.message}</div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              border: "1px solid rgba(103, 117, 141, 0.22)",
              background: "#ffffff",
              borderRadius: 999,
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <AppRuntimeBoundary>
    <App />
  </AppRuntimeBoundary>,
);

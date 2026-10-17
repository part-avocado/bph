import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useTheme } from "./lib/theme";
import "./styles.css";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function MissingKey() {
  return (
    <main className="mx-auto max-w-[520px] px-4 pt-[20vh]">
      <div className="card p-6">
        <h1 className="text-lg font-semibold tracking-heading">Clerk isn't configured</h1>
        <p className="mt-2 text-base leading-relaxed text-mute">
          Add <code className="font-mono text-ink">VITE_CLERK_PUBLISHABLE_KEY</code> to <code className="font-mono text-ink">.env</code> (see{" "}
          <code className="font-mono text-ink">.env.example</code>) and restart the dev server.
        </p>
      </div>
    </main>
  );
}

const LIGHT = { colorPrimary: "#0a0a0a", colorForeground: "#0a0a0a" };
const DARK = {
  colorPrimary: "#f4f4f5",
  colorForeground: "#f4f4f5",
  colorMutedForeground: "#9a9aa6",
  colorBackground: "#17171b",
  colorInput: "#0e0e11",
  colorInputForeground: "#f4f4f5",
  colorNeutral: "#f4f4f5",
  colorDanger: "#f87171",
  colorShimmer: "#2a2a31",
};

function Root({ publishableKey }: { publishableKey: string }) {
  const { theme } = useTheme();
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      afterSignOutUrl="/"
      appearance={{
        variables: {
          ...(theme === "dark" ? DARK : LIGHT),
          fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
          borderRadius: "10px",
        },
      }}
    >
      <App />
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{publishableKey ? <Root publishableKey={publishableKey} /> : <MissingKey />}</StrictMode>,
);

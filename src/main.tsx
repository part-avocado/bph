import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {publishableKey ? (
      <ClerkProvider
        publishableKey={publishableKey}
        afterSignOutUrl="/"
        appearance={{
          variables: {
            colorPrimary: "#0a0a0a",
            colorForeground: "#0a0a0a",
            fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
            borderRadius: "10px",
          },
        }}
      >
        <App />
      </ClerkProvider>
    ) : (
      <MissingKey />
    )}
  </StrictMode>,
);

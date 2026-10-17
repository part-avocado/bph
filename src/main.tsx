import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function MissingKey() {
  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 520, margin: "20vh auto", padding: 16, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 20 }}>Clerk isn't configured</h1>
      <p>
        Add <code>VITE_CLERK_PUBLISHABLE_KEY</code> to <code>.env</code> (see <code>.env.example</code>) and restart the dev server.
      </p>
    </div>
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

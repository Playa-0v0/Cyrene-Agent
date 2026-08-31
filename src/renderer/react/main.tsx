import React from "react";
import { createRoot } from "react-dom/client";
import "../ui/theme";
import { App } from "./App";
import { AppProviders } from "./app/providers/AppProviders";

const container = document.getElementById("cyrene-react-root");
if (!container) {
  throw new Error("Root element #cyrene-react-root not found");
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);

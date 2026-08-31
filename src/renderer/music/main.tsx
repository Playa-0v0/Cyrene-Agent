import React from "react";
import { createRoot } from "react-dom/client";
import "./player.css";
import { App } from "./App";

const container = document.getElementById("cyrene-music-root");
if (!container) {
  throw new Error("Root element #cyrene-music-root not found");
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

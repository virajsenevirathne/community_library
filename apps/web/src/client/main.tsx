import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./lib/push.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// Only shows reminder notifications; it caches nothing.
void registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

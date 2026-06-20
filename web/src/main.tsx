import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { messenger } from "./lib/messaging.js";
import "./styles.css";

// Boot the engine (loads keys, restores sessions, connects) once at startup.
void messenger.boot();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

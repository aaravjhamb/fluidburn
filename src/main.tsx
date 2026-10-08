import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { revealWindow } from "./lib/window";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Safety net: the window starts hidden (see tauri.conf.json) and App reveals
// it after the first screen commits. If anything throws before that point the
// user must still get a window, so reveal unconditionally after a grace period.
setTimeout(revealWindow, 2000);

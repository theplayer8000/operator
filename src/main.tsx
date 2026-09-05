import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./context/ThemeContext";
import { interceptExternalLinks } from "./lib/desktop";
import "./index.css";

/*
  Once, here, rather than in a component.

  It is a single capturing listener on `document` with no React state, and it
  has to cover every route — the Dev page's GitHub buttons, the Updates
  changelog, and links inside rendered markdown, which are generated at runtime
  and belong to no component anyone could go and fix. Mounting it per-page would
  mean remembering it on every page added afterwards, which is how the original
  bug lasted as long as it did.

  A no-op in a browser: `isDesktop()` is false and nothing is bound at all.
*/
interceptExternalLinks();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);

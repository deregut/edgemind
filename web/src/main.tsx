import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/lib/theme";
import { App } from "./App";
import { initPwa } from "@/lib/pwa";
import "./index.css";

initPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      {/* No React transitions for navigation: with them the previous page stays on screen and interactive until the
          new route finishes rendering, so a message typed right after 新對話 went into the previous (e.g. project)
          conversation and no new conversation was created. */}
      <BrowserRouter useTransitions={false}>
        <App />
        <Toaster richColors position="top-center" />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);

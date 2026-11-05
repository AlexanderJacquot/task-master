import { RouterProvider } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { CaptureWindow, tauriCaptureControls } from "./features/capture/CaptureWindow";
import { tauriApi } from "./lib/api";
import { applyTheme, loadTheme } from "./lib/theme";
import { createUpdateStore, tauriUpdates, UpdateProvider } from "./lib/updater";
import { createAppRouter } from "./router";
import { StoreProvider } from "./store/context";
import { createTaskStore } from "./store/store";

applyTheme(loadTheme());

const store = createTaskStore(tauriApi);
void store.getState().hydrate();
void store.getState().connect();

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// Both windows load this page; the quick-capture one renders only the capture box.
const isCapture = getCurrentWindow().label === "capture";

// Updates (ADR 009): a quiet check shortly after start and then every six hours, in the
// main window only. Settings has the button; the sidebar shows when one is available.
const updates = createUpdateStore(tauriUpdates);
if (!isCapture && !import.meta.env.DEV) {
  const quietCheck = () => void updates.getState().check({ quiet: true });
  setTimeout(quietCheck, 10_000);
  setInterval(quietCheck, 6 * 60 * 60 * 1000);
}

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store} api={tauriApi}>
      <UpdateProvider value={updates}>
        {isCapture ? (
          <CaptureWindow controls={tauriCaptureControls()} />
        ) : (
          <RouterProvider router={createAppRouter()} />
        )}
      </UpdateProvider>
    </StoreProvider>
  </StrictMode>,
);

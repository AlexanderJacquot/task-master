import { RouterProvider } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { events } from "./bindings";
import { CaptureWindow, tauriCaptureControls } from "./features/capture/CaptureWindow";
import { tauriApi } from "./lib/api";
import { applyAppearance, followAppearance } from "./lib/appearance";
import { createUpdateStore, tauriUpdates, UpdateProvider } from "./lib/updater";
import { createAppRouter } from "./router";
import { StoreProvider } from "./store/context";
import { createTaskStore } from "./store/store";

followAppearance();

const store = createTaskStore(tauriApi);
void store.getState().hydrate();
void store.getState().connect();

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

// Both windows load this page; the quick-capture one renders only the capture box.
const isCapture = getCurrentWindow().label === "capture";

// The capture window lives hidden from the app's start: besides `storage` events, read the
// appearance again each time the hotkey shows it, so a theme changed since then applies.
if (isCapture) void events.captureOpened.listen(() => applyAppearance());

// Agent runs are children of the app (ADR 017): ask before quitting stops them.
if (!isCapture) {
  void getCurrentWindow().onCloseRequested(async (event) => {
    const running = Object.keys(store.getState().agentActivity).length;
    if (running === 0) return;
    const quit = await ask(
      `${running === 1 ? "An agent session is" : `${running} agent sessions are`} still running. Quitting stops ${running === 1 ? "it" : "them"}; you can continue later with a follow-up.`,
      { title: "Quit task-master?", kind: "warning", okLabel: "Quit", cancelLabel: "Keep running" },
    );
    if (!quit) event.preventDefault();
  });
}

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

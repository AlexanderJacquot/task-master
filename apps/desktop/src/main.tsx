import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { tauriApi } from "./lib/api";
import { createAppRouter } from "./router";
import { StoreProvider } from "./store/context";
import { createTaskStore } from "./store/store";

const store = createTaskStore(tauriApi);
void store.getState().hydrate();
void store.getState().connect();
const router = createAppRouter();

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store} api={tauriApi}>
      <RouterProvider router={router} />
    </StoreProvider>
  </StrictMode>,
);

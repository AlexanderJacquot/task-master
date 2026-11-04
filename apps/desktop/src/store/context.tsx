import { createContext, type ReactNode, useContext } from "react";
import { useStore } from "zustand";
import type { Api } from "../lib/api";
import type { TaskStore, TaskStoreState } from "./store";

const Context = createContext<{ store: TaskStore; api: Api } | null>(null);

export function StoreProvider({
  store,
  api,
  children,
}: {
  store: TaskStore;
  api: Api;
  children: ReactNode;
}) {
  return <Context.Provider value={{ store, api }}>{children}</Context.Provider>;
}

function useContextValue() {
  const value = useContext(Context);
  if (!value) throw new Error("StoreProvider missing");
  return value;
}

export function useTaskStore(): TaskStore {
  return useContextValue().store;
}

export function useApi(): Api {
  return useContextValue().api;
}

/** Subscribes to a slice of the store. Select stable references (maps), derive with useMemo. */
export function useStoreState<T>(selector: (state: TaskStoreState) => T): T {
  return useStore(useContextValue().store, selector);
}

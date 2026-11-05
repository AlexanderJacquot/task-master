import { createContext, useContext } from "react";
import type { NewTaskInput } from "../../store/actions";

/** App-level UI actions that live in the Layout but are triggered from anywhere. */
export interface ShellActions {
  /** Opens the New task dialog; `defaults` are what the new task gets unless the line overrides. */
  openNewTask(defaults?: Omit<NewTaskInput, "title">): void;
  openPalette(): void;
}

const noop: ShellActions = { openNewTask() {}, openPalette() {} };

export const ShellContext = createContext<ShellActions>(noop);

export function useShell(): ShellActions {
  return useContext(ShellContext);
}

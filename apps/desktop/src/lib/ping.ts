import { commands } from "../bindings";

/** Calls the core `ping` command through the generated Tauri bindings. */
export function pingCore(): Promise<string> {
  return commands.ping();
}

// The app's own title bar on Windows and Linux (ADR 012). The main window has no system
// frame there (`tauri.windows.conf.json`, `tauri.linux.conf.json`), so this strip continues
// the sidebar and canvas colors to the top edge, drags the window (double-click maximizes,
// snapping still works) and draws the minimize / maximize / close buttons in the system's
// style. macOS keeps its native title bar and renders nothing here.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { cx } from "../../components/ui";

/** What the buttons need from the window; injected so tests can fake it. */
export interface WindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Calls `handler` whenever the window is resized (maximize and restore included). */
  onResized(handler: () => void): Promise<() => void>;
}

export const tauriWindowControls = (): WindowControls => {
  const win = getCurrentWindow();
  return {
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    isMaximized: () => win.isMaximized(),
    onResized: (handler) => win.onResized(() => handler()),
  };
};

/** Which buttons the strip draws: Windows' square ones or Linux desktops' round ones. */
export type TitleBarStyle = "windows" | "linux";

/** The style for a user agent; null where the window keeps its system frame (macOS). */
export function titleBarStyleFor(userAgent: string): TitleBarStyle | null {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Linux") && !userAgent.includes("Android")) return "linux";
  return null;
}

/** The title bar style of this window: set in the desktop app's frameless main window. */
export function customTitleBarStyle(): TitleBarStyle | null {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  if (getCurrentWindow().label !== "main") return null;
  return titleBarStyleFor(navigator.userAgent);
}

/** True in the Windows and Linux desktop app, where the main window is frameless. */
export function usesCustomTitleBar(): boolean {
  return customTitleBarStyle() !== null;
}

/** Height of the strip; the layout leaves this much room at the top. */
export const TITLE_BAR_HEIGHT = 32;

// Segoe Fluent Icons (Windows 11) / Segoe MDL2 Assets (Windows 10) glyphs, so the buttons
// look like every other app's.
const GLYPH = {
  minimize: "",
  maximize: "",
  restore: "",
  close: "",
} as const;

// Linux: line icons in round buttons, close on a red disc when hovered, as Breeze and
// Adwaita do; drawn as SVG since no icon font can be counted on.
const LINUX_ICON = {
  minimize: "M4 6.5 8 10.5 12 6.5",
  maximize: "M4 10 8 6 12 10",
  restore: "M8 4 12 8 8 12 4 8Z",
  close: "M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5",
} as const;

function LinuxButton({
  label,
  icon,
  onClick,
  close,
}: {
  label: string;
  icon: keyof typeof LINUX_ICON;
  onClick: () => void;
  close?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onClick={onClick}
      className={cx(
        "inline-flex size-6 items-center justify-center self-center rounded-full text-ink-2 transition-colors duration-100",
        close ? "hover:bg-[#da4453] hover:text-white active:bg-[#da4453]/80" : "hover:bg-hover",
      )}
    >
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={LINUX_ICON[icon]} />
      </svg>
    </button>
  );
}

function ControlButton({
  label,
  glyph,
  onClick,
  close,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
  close?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onClick={onClick}
      className={cx(
        "inline-flex h-full w-[46px] items-center justify-center text-[10px] text-ink-2 transition-colors duration-100",
        close ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/80" : "hover:bg-hover",
      )}
      style={{ fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"' }}
    >
      {glyph}
    </button>
  );
}

/**
 * The top strip: a sidebar-colored part as wide as the sidebar (`sidebarWidth`, 0 when
 * there is none, e.g. while loading) and a canvas-colored part holding the controls.
 */
export function TitleBar({
  controls,
  sidebarWidth,
  variant = "windows",
}: {
  controls: WindowControls;
  sidebarWidth: number | string;
  variant?: TitleBarStyle;
}) {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const refresh = () =>
      void controls.isMaximized().then(
        (m) => live && setMaximized(m),
        () => {},
      );
    refresh();
    controls.onResized(refresh).then(
      (unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      },
      () => {},
    );
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      live = false;
      stop?.();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [controls]);

  return (
    <header
      data-tauri-drag-region="deep"
      className={cx(
        "flex shrink-0 select-none items-stretch transition-opacity",
        !focused && "[&_button]:opacity-60",
      )}
      style={{ height: TITLE_BAR_HEIGHT }}
    >
      {sidebarWidth !== 0 && (
        <div
          className="tex-sidebar shrink-0 border-r border-line bg-sidebar"
          style={{ width: sidebarWidth }}
        />
      )}
      {variant === "linux" ? (
        <div className="flex min-w-0 flex-1 items-stretch justify-end gap-1.5 pr-2">
          <LinuxButton label="Minimize" icon="minimize" onClick={() => void controls.minimize()} />
          <LinuxButton
            label={maximized ? "Restore" : "Maximize"}
            icon={maximized ? "restore" : "maximize"}
            onClick={() => void controls.toggleMaximize()}
          />
          <LinuxButton label="Close" icon="close" onClick={() => void controls.close()} close />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-stretch justify-end">
          <ControlButton
            label="Minimize"
            glyph={GLYPH.minimize}
            onClick={() => void controls.minimize()}
          />
          <ControlButton
            label={maximized ? "Restore" : "Maximize"}
            glyph={maximized ? GLYPH.restore : GLYPH.maximize}
            onClick={() => void controls.toggleMaximize()}
          />
          <ControlButton
            label="Close"
            glyph={GLYPH.close}
            onClick={() => void controls.close()}
            close
          />
        </div>
      )}
    </header>
  );
}

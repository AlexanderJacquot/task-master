// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TitleBar, titleBarStyleFor, usesCustomTitleBar, type WindowControls } from "./TitleBar";

function fakeControls() {
  const calls: string[] = [];
  let maximized = false;
  let fullscreen = false;
  let resized: (() => void) | null = null;
  const controls: WindowControls = {
    minimize: async () => {
      calls.push("minimize");
    },
    toggleMaximize: async () => {
      calls.push("toggleMaximize");
      maximized = !maximized;
      resized?.();
    },
    close: async () => {
      calls.push("close");
    },
    isMaximized: async () => maximized,
    isFullscreen: async () => fullscreen,
    onResized: async (handler) => {
      resized = handler;
      return () => {
        resized = null;
      };
    },
  };
  const setFullscreen = (on: boolean) => {
    fullscreen = on;
    resized?.();
  };
  return { controls, calls, setFullscreen, unsubscribed: () => resized === null };
}

afterEach(cleanup);

describe("the Windows title bar", () => {
  it("drives the window and follows its maximized state", async () => {
    const fake = fakeControls();
    render(<TitleBar controls={fake.controls} sidebarWidth={264} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(fake.calls).toEqual(["minimize", "toggleMaximize", "close"]);
  });

  it("drags from the whole strip and extends the sidebar color to the top", () => {
    const { container } = render(<TitleBar controls={fakeControls().controls} sidebarWidth={60} />);
    const strip = container.querySelector("header") as HTMLElement;
    expect(strip.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect((strip.firstElementChild as HTMLElement).style.width).toBe("60px");
  });

  it("stops listening when unmounted", async () => {
    const fake = fakeControls();
    const { unmount } = render(<TitleBar controls={fake.controls} sidebarWidth={0} />);
    await waitFor(() => expect(fake.unsubscribed()).toBe(false));
    act(() => unmount());
    expect(fake.unsubscribed()).toBe(true);
  });

  it("is only used inside the desktop app", () => {
    expect(usesCustomTitleBar()).toBe(false);
  });

  it("picks the style from the system", () => {
    expect(titleBarStyleFor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe(
      "windows",
    );
    expect(titleBarStyleFor("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
    expect(titleBarStyleFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit")).toBe(
      "macos",
    );
    expect(titleBarStyleFor("Mozilla/5.0 (Linux; Android 15) AppleWebKit")).toBe(null);
  });
});

describe("the Linux title bar", () => {
  it("drives the window with round icon buttons", async () => {
    const fake = fakeControls();
    const { container } = render(
      <TitleBar controls={fake.controls} sidebarWidth={264} variant="linux" />,
    );
    expect(container.querySelector("header")?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(container.querySelectorAll("button svg")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(fake.calls).toEqual(["minimize", "toggleMaximize", "close"]);
  });
});

describe("the macOS title bar", () => {
  it("leaves the buttons to the native traffic lights and still drags", () => {
    const { container } = render(
      <TitleBar controls={fakeControls().controls} sidebarWidth={264} variant="macos" />,
    );
    const strip = container.querySelector("header") as HTMLElement;
    expect(strip.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect((strip.firstElementChild as HTMLElement).style.width).toBe("264px");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("is all canvas over the folded sidebar, which is narrower than the traffic lights", () => {
    const { container } = render(
      <TitleBar controls={fakeControls().controls} sidebarWidth={60} variant="macos" />,
    );
    const strip = container.querySelector("header") as HTMLElement;
    expect(strip.querySelector(".bg-sidebar")).toBeNull();
  });

  it("goes away in full screen, where macOS hides the title bar", async () => {
    const fake = fakeControls();
    const { container } = render(
      <TitleBar controls={fake.controls} sidebarWidth={264} variant="macos" />,
    );
    await waitFor(() => expect(fake.unsubscribed()).toBe(false));
    act(() => fake.setFullscreen(true));
    await waitFor(() => expect(container.querySelector("header")).toBeNull());
    act(() => fake.setFullscreen(false));
    await waitFor(() => expect(container.querySelector("header")).not.toBeNull());
  });
});

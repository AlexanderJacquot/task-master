// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TitleBar, usesCustomTitleBar, type WindowControls } from "./TitleBar";

function fakeControls() {
  const calls: string[] = [];
  let maximized = false;
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
    onResized: async (handler) => {
      resized = handler;
      return () => {
        resized = null;
      };
    },
  };
  return { controls, calls, unsubscribed: () => resized === null };
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

  it("is only used inside the Windows app", () => {
    expect(usesCustomTitleBar()).toBe(false);
  });
});

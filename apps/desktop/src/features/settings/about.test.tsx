// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD, createUpdateStore, UpdateProvider, type UpdateSource } from "../../lib/updater";
import { About } from "./About";

afterEach(cleanup);

function renderAbout(src: UpdateSource) {
  const store = createUpdateStore(src);
  render(
    <UpdateProvider value={store}>
      <About />
    </UpdateProvider>,
  );
  return store;
}

describe("About and updates", () => {
  it("shows the version and build", () => {
    renderAbout({ check: async () => null, relaunch: async () => {} });
    expect(screen.getByTestId("app-version").textContent).toBe(`Version ${BUILD.version}`);
    expect(screen.getByText(new RegExp(`build ${BUILD.commit}`))).toBeTruthy();
    expect(screen.getByTestId("app-license").textContent).toContain(
      "GNU Affero General Public License, version 3 or later",
    );
  });

  it("checks, installs and offers a restart", async () => {
    let relaunched = false;
    let finish: () => void = () => {};
    renderAbout({
      check: async () => ({
        version: "9.9.9",
        notes: "Better things",
        date: null,
        install: (progress) =>
          new Promise<void>((resolve) => {
            progress(0.4);
            finish = resolve;
          }),
      }),
      relaunch: async () => {
        relaunched = true;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Check for updates/ }));
    expect(await screen.findByText("Version 9.9.9 is available.")).toBeTruthy();
    expect(screen.getByText("Better things")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Download and install/ }));
    expect((await screen.findByRole("progressbar")).getAttribute("aria-valuenow")).toBe("40");
    await act(async () => finish());
    fireEvent.click(await screen.findByRole("button", { name: /Restart now/ }));
    await act(async () => {});
    expect(relaunched).toBe(true);
  });

  it("explains a failed check and lets you retry", async () => {
    renderAbout({ check: () => Promise.reject(new Error("offline")), relaunch: async () => {} });
    fireEvent.click(screen.getByRole("button", { name: /Check for updates/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
  });

  it("says updates need the desktop app when no updater is provided", () => {
    render(<About />);
    expect(screen.getByText(/available in the desktop app/)).toBeTruthy();
  });
});

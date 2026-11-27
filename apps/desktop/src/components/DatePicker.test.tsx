// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DatePicker } from "./DatePicker";

afterEach(cleanup);

function ControlledPicker({
  initial,
  today,
  changes,
}: {
  initial: string | null;
  today: string;
  changes: Array<string | null>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DatePicker
      aria-label="Due date"
      today={today}
      value={value}
      onValueChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
    />
  );
}

function setup(initial: string | null = null, today = "2026-11-05") {
  const changes: Array<string | null> = [];
  render(<ControlledPicker initial={initial} today={today} changes={changes} />);
  const trigger = screen.getByRole("button", { name: "Due date" });
  fireEvent.click(trigger);
  return { trigger, changes };
}

describe("date picker", () => {
  it("sets a quick date, clears it, and restores focus to the trigger", async () => {
    const { trigger, changes } = setup();
    expect(screen.getByRole("dialog", { name: "Choose due date" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow" }));
    expect(changes).toEqual(["2026-11-06"]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(changes).toEqual(["2026-11-06", null]);
  });

  it("opens at the selected date and navigates across the year without saving until a day is chosen", async () => {
    const { changes } = setup("2026-12-31");
    const selected = screen.getByRole("button", { name: "Thursday, December 31, 2026" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(selected));
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("January 2027")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("December 2026")).toBeTruthy();
    expect(changes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Wednesday, December 30, 2026" }));
    expect(changes).toEqual(["2026-12-30"]);
  });

  it("moves keyboard focus across months and clamps page navigation to leap-month boundaries", async () => {
    const { changes } = setup("2028-01-31");
    const day = screen.getByRole("button", { name: "Monday, January 31, 2028" });
    fireEvent.keyDown(day, { key: "PageDown" });
    const leapDay = screen.getByRole("button", { name: "Tuesday, February 29, 2028" });
    expect(document.activeElement).toBe(leapDay);
    fireEvent.keyDown(leapDay, { key: "ArrowRight" });
    const march = screen.getByRole("button", { name: "Wednesday, March 1, 2028" });
    expect(document.activeElement).toBe(march);
    fireEvent.keyDown(march, { key: "Home" });
    const monday = screen.getByRole("button", { name: "Monday, February 28, 2028" });
    expect(document.activeElement).toBe(monday);
    fireEvent.keyDown(monday, { key: "End" });
    const sunday = screen.getByRole("button", { name: "Sunday, March 5, 2028" });
    expect(document.activeElement).toBe(sunday);
    expect(changes).toEqual([]);
    fireEvent.click(sunday);
    expect(changes).toEqual(["2028-03-05"]);
  });

  it("validates typed dates without normalizing invalid days into another month", () => {
    const { changes } = setup();
    const input = screen.getByRole("textbox", { name: "Enter date" });
    fireEvent.change(input, { target: { value: "2027-02-29" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply date" }));
    expect(screen.getByRole("alert").textContent).toContain("valid date");
    expect(changes).toEqual([]);
    fireEvent.change(input, { target: { value: "2028-02-29" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply date" }));
    expect(changes).toEqual(["2028-02-29"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels drafts with Escape and resets the view when reopened", async () => {
    const { trigger, changes } = setup("2026-11-05");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    const input = screen.getByRole("textbox", { name: "Enter date" });
    fireEvent.change(input, { target: { value: "2027-01-01" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(changes).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(trigger);
    expect(screen.getByText("November 2026")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Enter date" }) as HTMLInputElement).value).toBe(
      "2026-11-05",
    );
  });

  it("uses local calendar dates for quick choices across a daylight saving transition", () => {
    const { changes } = setup(null, "2026-03-28");
    fireEvent.click(screen.getByRole("button", { name: "In a week" }));
    expect(changes).toEqual(["2026-04-04"]);
  });
});

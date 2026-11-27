import { fireEvent, screen } from "@testing-library/react";

/** Picks `option` in the select named `label` (components/ui Select or a property pill). */
export async function pickOption(label: string | HTMLElement, option: string | RegExp) {
  const trigger =
    typeof label === "string" ? await screen.findByRole("combobox", { name: label }) : label;
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

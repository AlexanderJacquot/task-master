import { Copy, FileImage, ImageDown } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
import { DownloadIcon } from "../../components/TaskIcons";
import { Button, cx, MENU, MENU_ITEM, MENU_SEPARATOR } from "../../components/ui";
import type { RoadmapImage } from "../../lib/types";
import { copyImage, type ImageFormat, saveImageAs } from "./exportImage";

/**
 * "Export image" in the Roadmap's header: the whole timeline (only its bars) as a PNG on the
 * clipboard, or a PNG or SVG file. `build` makes the image from the page as it is now.
 */
export function ExportImageMenu({
  build,
  today,
  disabled,
  onDone,
  onError,
}: {
  build(): RoadmapImage;
  today: string;
  disabled: boolean;
  onDone(message: string): void;
  onError(message: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const fail = (err: unknown) =>
    onError(`Could not export the image: ${err instanceof Error ? err.message : String(err)}`);

  function copy() {
    setBusy(true);
    // Straight from the click: the clipboard is only open to the page during it.
    copyImage(build())
      .then(() => onDone("Copied the image to the clipboard."))
      .catch(fail)
      .finally(() => setBusy(false));
  }
  function saveAs(format: ImageFormat) {
    setBusy(true);
    saveImageAs(build(), format, today)
      .then((path) => path && onDone(`Saved the image to ${path}`))
      .catch(fail)
      .finally(() => setBusy(false));
  }

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <Button
          size="sm"
          busy={busy}
          className="disabled:opacity-40"
          title={
            disabled
              ? "Nothing is scheduled to draw yet"
              : "The whole timeline as an image: only scheduled bars, without empty rows"
          }
        >
          {!busy && <ImageDown size={14} />}
          Export image
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cx(MENU, "min-w-52")}>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={copy}>
            <Copy size={15} />
            Copy as PNG
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={MENU_SEPARATOR} />
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => saveAs("png")}>
            <DownloadIcon size={15} />
            Save as PNG…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => saveAs("svg")}>
            <FileImage size={15} />
            Save as SVG…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

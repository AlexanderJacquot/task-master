// The pieces each asset-lab slot renders (src/lib/ornaments.ts). Every one is decorative:
// empty alt, aria-hidden, no pointer events, and renders nothing when its slot is off.

import { type ReactNode, useEffect } from "react";
import appIconSvg from "../../assets/brand/app-icon.svg";
import { cx } from "../../components/ui";
import { PACK, useOrnament, useOrnamentUrl } from "../../lib/ornaments";

/** The app logo: the chosen pack icon, or the vector one. */
export function AppLogo({
  size,
  className,
  alt = "",
}: {
  size: number;
  className?: string;
  alt?: string;
}) {
  const url = useOrnamentUrl("logo") ?? appIconSvg;
  return <img src={url} width={size} height={size} alt={alt} className={className} />;
}

/** Keeps the window favicon in step with the logo slot. Render once. */
export function FaviconSync() {
  const url = useOrnamentUrl("logo") ?? appIconSvg;
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.type = url.endsWith(".svg") ? "image/svg+xml" : "image/webp";
    link.href = url;
  }, [url]);
  return null;
}

/** The sidebar title: the painted wordmark or the display-font text. */
export function Wordmark({ children }: { children: ReactNode }) {
  const url = useOrnamentUrl("wordmark");
  if (!url) return children;
  return (
    <img src={url} alt="Task Master" className="h-8 w-auto max-w-full object-contain object-left" />
  );
}

/** A flourish under a page title. */
export function TitleFlourish() {
  const url = useOrnamentUrl("heading");
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      className="pointer-events-none -mt-1 mb-0.5 h-5 w-auto max-w-72 object-contain object-left opacity-90"
    />
  );
}

/** A small emblem before a page title. */
export function TitleCrest() {
  const url = useOrnamentUrl("headingCrest");
  if (!url) return null;
  return <img src={url} alt="" aria-hidden className="h-9 w-auto shrink-0 object-contain" />;
}

/** Whether the done stamp replaces the built-in tick. */
export function useDoneStamp(): boolean {
  return useOrnament("doneMark") !== null;
}

/** A wax seal pressed into the corner of a done card. */
export function DoneStamp({ cancelled }: { cancelled?: boolean }) {
  const url = useOrnamentUrl("doneMark");
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      className={cx(
        "pointer-events-none absolute right-2 bottom-1.5 size-10 rotate-[-14deg] object-contain drop-shadow-sm",
        cancelled && "opacity-50 grayscale",
      )}
    />
  );
}

/** A ribbon hanging from the top edge of a high-priority card. */
export function PriorityRibbon({ urgent }: { urgent: boolean }) {
  const url = useOrnamentUrl("priorityRibbon");
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      className={cx(
        "pointer-events-none absolute -top-1 right-3 w-auto object-contain object-top drop-shadow",
        urgent ? "h-11" : "h-8 opacity-80 hue-rotate-[25deg] saturate-75",
      )}
    />
  );
}

/** The art on an empty page, with the message set on or under it. */
export function EmptyArt({ children }: { children: ReactNode }) {
  const key = useOrnament("emptyState");
  const url = key ? PACK[key] : undefined;
  const text = <p className="font-display text-lg text-ink-3">{children}</p>;
  if (!url) return <div className="p-10 text-center">{text}</div>;
  // The blank scroll and parchment panel hold the text; the others sit above it.
  const holdsText = key === "decorations/scroll-empty" || key === "decorations/parchment-panel";
  if (holdsText) {
    return (
      <div className="flex justify-center p-10">
        <div className="relative flex aspect-[2/1] w-[min(30rem,90%)] items-center justify-center">
          <img src={url} alt="" aria-hidden className="absolute inset-0 size-full object-contain" />
          <p className="relative px-16 text-center font-display text-lg text-[#5b4126]">
            {children}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 p-10 text-center">
      <img src={url} alt="" aria-hidden className="h-32 w-auto object-contain opacity-90" />
      {text}
    </div>
  );
}

/** Gilded corners and a faint tile behind the main pane. Render inside a `relative` box. */
export function MainDecor() {
  const corner = useOrnamentUrl("corners");
  const tile = useOrnamentUrl("background");
  return (
    <>
      {tile && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: `url(${tile})`, backgroundSize: "128px" }}
        />
      )}
      {corner && (
        <>
          <img
            src={corner}
            alt=""
            aria-hidden
            className="pointer-events-none absolute top-1 left-1 z-10 w-16 opacity-80"
          />
          <img
            src={corner}
            alt=""
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 z-10 w-16 -scale-x-100 opacity-80"
          />
        </>
      )}
    </>
  );
}

/** A sidebar icon: the gold raster `ui/<name>` when that slot is on, else `fallback`. */
export function NavIcon({
  name,
  size,
  fallback,
}: {
  name: string;
  size: number;
  fallback: ReactNode;
}) {
  const gold = useOrnament("navIcons") === "gold";
  const url = PACK[`ui/${name}`];
  if (!gold || !url) return fallback;
  return <img src={url} alt="" aria-hidden width={size} height={size} className="shrink-0" />;
}

/** The banner at the top of Settings → About. */
export function AboutHero() {
  const url = useOrnamentUrl("aboutHero");
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      className="mb-4 max-h-48 w-full rounded-xl border border-line object-cover"
    />
  );
}

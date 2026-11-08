import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";

/** Sets the textarea's height to its content, so no line of the title is hidden. */
export function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * A textarea that grows with its text. CSS `field-sizing: content` would do this, but
 * WebKitGTK (the Linux webview) ignores it, which left long titles cut off at `rows`.
 */
export function TitleField(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { onInput } = props;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitHeight(el);
    // Wrapping changes with the width (panel resize, window resize) and once fonts load.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    void document.fonts?.ready.then(() => fitHeight(el));
    return () => observer.disconnect();
  }, []);

  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      onInput={(e) => {
        fitHeight(e.currentTarget);
        onInput?.(e);
      }}
    />
  );
}

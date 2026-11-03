"use client";

import { forwardRef, useRef, useState, type ReactNode } from "react";
import { IconBack, IconClose } from "./icons";

export type Detent = "peek" | "half" | "full";

const ORDER: Detent[] = ["peek", "half", "full"];
const WORDS: Record<Detent, string> = { peek: "small", half: "half", full: "full" };
const PEEK_PX = 176;
/** The full sheet stops below this band, so the brand, the map buttons and the map's credits stay visible. */
export const TOP_BAND_PX = 84;

/** The sheet's height in pixels at a detent, for a viewport `vh` pixels tall. */
export function detentPx(detent: Detent, vh: number): number {
  if (detent === "peek") return PEEK_PX;
  if (detent === "half") return Math.round(vh / 2);
  return vh - TOP_BAND_PX;
}

function nearest(px: number, vh: number): Detent {
  return ORDER.reduce((best, d) => (Math.abs(detentPx(d, vh) - px) < Math.abs(detentPx(best, vh) - px) ? d : best), "peek");
}

const HEIGHT: Record<Detent, string> = {
  peek: "var(--peek)",
  half: "50dvh",
  full: "calc(100dvh - var(--top-band))",
};

/**
 * A nonmodal bottom sheet over the live map with three heights. The grabber is a button: a tap cycles the heights,
 * ↑ and ↓ move one, and a drag follows the pointer and settles on the nearest. From 1024 px wide it is a side panel.
 */
export function Sheet({
  detent,
  onDetent,
  labelledBy,
  children,
}: {
  detent: Detent;
  onDetent: (d: Detent) => void;
  labelledBy: string;
  children: ReactNode;
}) {
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const self = useRef<HTMLElement>(null);
  const justDragged = useRef(false);

  function step(by: 1 | -1) {
    const i = ORDER.indexOf(detent) + by;
    if (i >= 0 && i < ORDER.length) onDetent(ORDER[i]);
  }

  return (
    <section
      ref={self}
      role="region"
      aria-labelledby={labelledBy}
      data-detent={detent}
      style={{ height: dragPx === null ? HEIGHT[detent] : `${dragPx}px` }}
      className={`glass fixed inset-x-0 bottom-0 z-20 flex flex-col rounded-t-sheet border-t border-line/70 shadow-[0_-8px_32px_rgb(0_0_0/0.18)] ${
        dragPx === null ? "transition-[height] duration-(--dur-3) ease-(--ease-spring)" : ""
      } lg:inset-x-auto lg:top-4 lg:bottom-4 lg:left-4 lg:h-auto! lg:w-[400px] lg:rounded-sheet lg:border`}
    >
      <div className="flex shrink-0 justify-center lg:hidden">
        <button
          type="button"
          aria-label={`Panel: ${WORDS[detent]} height`}
          className="flex h-8 w-24 touch-none cursor-grab items-center justify-center"
          onClick={() => {
            if (justDragged.current) {
              justDragged.current = false;
              return;
            }
            onDetent(ORDER[(ORDER.indexOf(detent) + 1) % ORDER.length]);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              step(1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              step(-1);
            }
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            justDragged.current = false;
            drag.current = { y: e.clientY, h: self.current?.offsetHeight ?? PEEK_PX, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dy = e.clientY - d.y;
            if (!d.moved && Math.abs(dy) < 6) return;
            d.moved = true;
            const vh = window.innerHeight;
            setDragPx(Math.min(detentPx("full", vh), Math.max(PEEK_PX, d.h - dy)));
          }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = null;
            if (!d?.moved || dragPx === null) return;
            justDragged.current = true;
            onDetent(nearest(dragPx, window.innerHeight));
            setDragPx(null);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragPx(null);
          }}
        >
          <span aria-hidden className="block h-1.5 w-10 rounded-chip bg-ink-2/50" />
        </button>
      </div>
      {children}
    </section>
  );
}

/** The sheet's scrolling body. */
export const SheetBody = forwardRef<HTMLDivElement, { children: ReactNode }>(function SheetBody({ children }, ref) {
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:pt-4">
      {children}
    </div>
  );
});

/** A view's heading with Back (or Close). The heading takes focus when the view opens. */
export const SheetHeader = forwardRef<HTMLHeadingElement, { id: string; title: string; onBack: () => void; close?: boolean }>(
  function SheetHeader({ id, title, onBack, close }, ref) {
    return (
      <header className="glass sticky top-0 z-10 -mx-4 mb-3 flex items-center gap-2 px-4 pb-2 pt-1">
        <button
          type="button"
          onClick={onBack}
          aria-label={close ? "Close" : "Back"}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink"
        >
          {close ? <IconClose /> : <IconBack />}
        </button>
        <h2 id={id} ref={ref} tabIndex={-1} className="text-title outline-none">
          {title}
        </h2>
      </header>
    );
  },
);

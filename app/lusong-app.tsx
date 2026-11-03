"use client";

import dynamic from "next/dynamic";
import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { DEMO_TRIPS } from "../lib/samples";
import { AnswerCard } from "./answer-card";
import { CheckProgress } from "./check-progress";
import { commuteReducer, initialCommuteState, OWN_TRIP, type CommuteInputs, type CommuteState } from "./commute-state";
import type { CommuteResult } from "./commute-result";
import { CREDITS_LINE } from "./credits";
import { Evidence } from "./evidence";
import { advisoryAreasOf, ALL_LAYERS, areaShapes, fitPadding, legendRows, type LayerId, type LayerToggles } from "./map-layers";
import { MapLegend } from "./map-legend";
import { tripMapProps } from "./map-props";
import { CLEAR_FAILED_LINE, outsideLine, useOwnTrip } from "./own-trip";
import { backMove, PUSHED_KEY, viewFromSearch, type SheetView } from "./sheet-route";
import { checkRequest } from "./trip";
import { IconCamera, IconInfo, IconLayers } from "./ui/icons";
import { detentPx, Sheet, SheetBody, SheetHeader, type Detent } from "./ui/sheet";
import { ErrorNote } from "./ui/states";
import { ToastProvider, useToast } from "./ui/toast";
import { AboutView, CheckView, ReportView, WatchView } from "./views";
import { inputWords, WhereTo } from "./where-to";

// Leaflet needs the browser's window, so the map is never rendered on the server.
const TripMap = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-ground" />,
});

type Answered = CommuteResult & { checkedAt: string };

const VIEW_TITLES: Record<SheetView, string> = {
  report: "Report a street",
  check: "Check one photo",
  watch: "Watcher on Telegram",
  about: "About Lusong",
  legend: "Map layers",
};
const WHERE_HEADING = "where-heading";
const VIEW_HEADING = "view-heading";
const VIEW_DETENT: Record<SheetView, Detent> = { report: "half", check: "full", watch: "half", about: "half", legend: "half" };

const locationListeners = new Set<() => void>();
function subscribeLocation(listener: () => void) {
  locationListeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    locationListeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}
const locationChanged = () => locationListeners.forEach((l) => l());

const DESKTOP = "(min-width: 1024px)";
function subscribeMedia(listener: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}
function subscribeResize(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

function Shell() {
  const toast = useToast();
  const [state, dispatch] = useReducer(commuteReducer<Answered>, initialCommuteState as CommuteState<Answered>);
  const { trip } = state.inputs;
  const view = state.view;
  const own = useOwnTrip(() => dispatch({ type: "change", inputs: {} }), {
    outside: () => toast(outsideLine()),
    clearFailed: () => toast(CLEAR_FAILED_LINE),
  });
  const ownTrip = trip === OWN_TRIP;
  const savedTrip = own.draft.step === "set" ? own.draft.trip : null;

  const sheetView = useSyncExternalStore(subscribeLocation, () => viewFromSearch(window.location.search), () => null);
  const desktop = useSyncExternalStore(subscribeMedia, () => window.matchMedia(DESKTOP).matches, () => false);
  const vh = useSyncExternalStore(subscribeResize, () => window.innerHeight, () => 844);
  const [detent, setDetent] = useState<Detent>("half");
  const [editing, setEditing] = useState(false);
  const [layers, setLayers] = useState<LayerToggles>(ALL_LAYERS);
  const [focusPin, setFocusPin] = useState<{ id: string; n: number } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const shownView = useRef<SheetView | null>(null);
  const latestTicket = useRef(state.ticket);
  useEffect(() => {
    latestTicket.current = state.ticket;
  });

  // A trip saved on an earlier visit is chosen once it is read, so the next check is one tap.
  const restored = useRef(false);
  useEffect(() => {
    if (!savedTrip || restored.current) return;
    restored.current = true;
    dispatch({ type: "change", inputs: { trip: OWN_TRIP } });
  }, [savedTrip]);

  // A view's heading takes focus when it opens; closing it returns focus to whatever opened it.
  useEffect(() => {
    if (sheetView) viewHeading.current?.focus();
    else if (shownView.current) {
      const back = opener.current && document.contains(opener.current) ? opener.current : document.getElementById(WHERE_HEADING);
      back?.focus();
      opener.current = null;
    }
    shownView.current = sheetView;
  }, [sheetView]);

  const result = view.step === "done" ? view.result : null;
  const sheetPx = desktop ? 0 : detentPx(detent, vh);
  const base = tripMapProps({ demo: ownTrip ? null : DEMO_TRIPS[trip], draft: own.draft, riderMoved: own.touched, result });
  const areas = areaShapes(advisoryAreasOf(result));

  function change(inputs: Partial<CommuteInputs>) {
    dispatch({ type: "change", inputs });
  }

  function openView(v: SheetView) {
    if (sheetView === v) {
      viewHeading.current?.focus();
      return;
    }
    if (sheetView) {
      // From one view to another: the entry is replaced, so Back still leads to the commute and the first opener.
      window.history.replaceState({ [PUSHED_KEY]: backMove(window.history.state) === "history-back" }, "", `?sheet=${v}`);
    } else {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.history.pushState({ [PUSHED_KEY]: true }, "", `?sheet=${v}`);
    }
    locationChanged();
    setDetent(VIEW_DETENT[v]);
  }

  function closeView() {
    if (backMove(window.history.state) === "history-back") {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", window.location.pathname);
    locationChanged();
  }

  async function check() {
    const ticket = state.ticket + 1;
    const inputs = state.inputs;
    dispatch({ type: "start", at: Date.now() });
    setEditing(false);
    if (detent === "peek") setDetent("half");
    try {
      const res = await fetch("/api/commute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputs.trip === OWN_TRIP ? checkRequest(savedTrip!, inputs.rainingHere) : { mode: "demo", ...inputs }),
      });
      const reply = await res.json().catch(() => null);
      if (!res.ok || !reply?.answer) {
        dispatch({ type: "failed", ticket, message: reply?.error ?? "Lusong couldn't run the check. Try again in a minute." });
        return;
      }
      dispatch({ type: "answered", ticket, result: { ...(reply as CommuteResult), checkedAt: new Date().toISOString() } });
      // Only the answer still shown moves the sheet, and never while the rider is in another view.
      if (latestTicket.current === ticket && viewFromSearch(window.location.search) === null) {
        setDetent("half");
        body.current?.scrollTo({ top: 0 });
      }
    } catch {
      dispatch({ type: "failed", ticket, message: "Lusong couldn't be reached. Check your connection." });
    }
  }

  const rows = legendRows(result, result?.checkedAt ?? null);
  const samplesShown = Boolean(result?.reports.some((r) => r.sample));
  const collapsed = view.step !== "idle" && !editing;

  return (
    <main className="h-dvh overflow-hidden">
      <TripMap
        {...base}
        onTap={ownTrip ? own.tap : undefined}
        areas={areas}
        layers={layers}
        padding={fitPadding({ desktop, sheetPx, vh })}
        bottomInset={sheetPx}
        hideBottom={!desktop && detent === "full"}
        focusPin={focusPin}
      />

      <div className="pointer-events-none fixed inset-x-0 top-0 z-10 flex items-start justify-between gap-2 px-4 pt-7 lg:pl-[432px]">
        <h1 className="glass pointer-events-auto rounded-chip border border-line/70 px-4 py-2 text-title shadow-md">Lusong</h1>
        <div className="pointer-events-auto flex gap-2">
          <button
            type="button"
            aria-label="About Lusong"
            onClick={() => openView("about")}
            className="glass inline-flex h-11 w-11 items-center justify-center rounded-full border border-line/70 text-ink shadow-md"
          >
            <IconInfo />
          </button>
          <button
            type="button"
            aria-label="Map layers"
            onClick={() => openView("legend")}
            className="glass inline-flex h-11 w-11 items-center justify-center rounded-full border border-line/70 text-ink shadow-md"
          >
            <IconLayers />
          </button>
        </div>
      </div>

      {(desktop || detent !== "full") && (
        <button
          type="button"
          onClick={() => openView("report")}
          style={desktop ? undefined : { bottom: sheetPx + 12 }}
          className="glass fixed left-4 z-10 inline-flex min-h-11 items-center gap-2 rounded-chip border border-line/70 px-4 font-semibold text-ink shadow-md transition-[bottom] duration-(--dur-3) ease-(--ease-spring) lg:bottom-6 lg:left-[432px]"
        >
          <IconCamera />
          Report a street
        </button>
      )}

      <Sheet detent={desktop ? "full" : detent} onDetent={setDetent} labelledBy={sheetView ? VIEW_HEADING : WHERE_HEADING}>
        <SheetBody ref={body}>
          {sheetView && (
            <div>
              <SheetHeader id={VIEW_HEADING} ref={viewHeading} title={VIEW_TITLES[sheetView]} onBack={closeView} />
              {sheetView === "report" && <ReportView />}
              {sheetView === "check" && <CheckView />}
              {sheetView === "watch" && <WatchView trip={savedTrip} />}
              {sheetView === "about" && <AboutView />}
              {sheetView === "legend" && (
                <MapLegend rows={rows} layers={layers} samplesShown={samplesShown} onToggle={(id: LayerId) => setLayers((l) => ({ ...l, [id]: !l[id] }))} />
              )}
            </div>
          )}
          {/* Kept mounted under a view, so a half-typed place or a running check survives a trip to Report and back. */}
          <div hidden={sheetView !== null} className="space-y-5 pt-1">
            <WhereTo
              headingId={WHERE_HEADING}
              inputs={state.inputs}
              change={change}
              own={own}
              checking={view.step === "checking"}
              canCheck={!ownTrip || Boolean(savedTrip)}
              onCheck={check}
              onFocusBox={() => setDetent("full")}
              focusSignal={focusSignal}
              onPickMyTrip={() => {
                if (!savedTrip) setFocusSignal((n) => n + 1);
              }}
              onOpenWatcher={() => openView("watch")}
              collapsed={collapsed}
              onExpand={() => setEditing(true)}
              summary={view.step === "idle" ? null : inputWords(view.for)}
            />
            {view.step === "checking" && <CheckProgress since={view.startedAt} />}
            <div aria-live="polite" className="space-y-4">
              {view.step === "failed" && <ErrorNote onRetry={check}>{view.message}</ErrorNote>}
              {view.step === "done" && <AnswerCard result={view.result} />}
            </div>
            {view.step === "done" && (
              <Evidence
                result={view.result}
                onShowReport={(id) => {
                  if (!desktop) setDetent("peek");
                  setLayers((l) => ({ ...l, reports: true }));
                  setFocusPin((f) => ({ id, n: (f?.n ?? 0) + 1 }));
                }}
                onWatch={view.for.trip === OWN_TRIP && savedTrip ? () => openView("watch") : undefined}
                onReport={() => openView("report")}
              />
            )}
            <footer className="space-y-3 border-t border-line pt-4 text-small text-ink-2">
              <p>{CREDITS_LINE}</p>
              <div className="flex flex-wrap gap-x-4">
                <button type="button" className="min-h-11 font-semibold text-brand underline" onClick={() => openView("report")}>
                  Report a street
                </button>
                <button type="button" className="min-h-11 font-semibold text-brand underline" onClick={() => openView("check")}>
                  Check one photo
                </button>
                <button type="button" className="min-h-11 font-semibold text-brand underline" onClick={() => openView("about")}>
                  About Lusong
                </button>
              </div>
            </footer>
          </div>
        </SheetBody>
      </Sheet>
    </main>
  );
}

export default function LusongApp() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

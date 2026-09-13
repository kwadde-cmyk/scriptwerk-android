import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronsLeft, ChevronsRight, FileCode2, GitFork, KeyRound, Layers, SlidersHorizontal } from "lucide-react";
import { InterpreterPanel } from "@/components/interpreter-panel";
import { ImportExportBar } from "@/components/import-export";
import { KeyDatalist, OperatorPalette } from "@/components/operator-palette";
import { NodeInspector } from "@/components/node-inspector";
import { KeyBoard, KeyReuseControls } from "@/components/key-board";
import { PolicyGraph } from "@/components/policy-graph";
import { StageBuilder, ExpertPolicySettings } from "@/components/stage-builder";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultStages } from "@/lib/miniscript/stages";
import { useStudio } from "@/store/studio";
import { useT } from "@/lib/use-t";
import { RecoveryPrintRoot } from "@/components/recovery-sheet";
import { NodeAutoSync } from "@/components/node-rpc";
import { AndroidInstallBanner } from "@/components/android-chrome";
import { installNativeUsbPolyfill } from "@/lib/hw/native-usb";
import { Toaster } from "sonner";
import type { Locale } from "@/lib/i18n";

export function StudioShell() {
  const { t, locale, setLocale } = useT();

  useEffect(() => {
    void installNativeUsbPolyfill();
  }, []);

  useEffect(() => {
    const unlock = () => {
      document.body.style.pointerEvents = "";
      document.body.removeAttribute("data-scroll-locked");
    };
    unlock();
    window.addEventListener("pointerdown", unlock, true);
    return () => window.removeEventListener("pointerdown", unlock, true);
  }, []);

  useEffect(() => {
    void Promise.resolve(useStudio.persist.rehydrate()).then(() => {
      const s = useStudio.getState();
      if (s.root) {
        useStudio.setState({ past: [], future: [] });
        return;
      }
      if (s.stages?.length) s.setStages(s.stages);
      else s.setStages(defaultStages());
      useStudio.setState({ past: [], future: [] });
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        useStudio.getState().undo();
        return;
      }
      if ((e.key === "z" && e.shiftKey) || e.key.toLowerCase() === "y") {
        e.preventDefault();
        useStudio.getState().redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <TooltipProvider delayDuration={200}>
      <KeyDatalist />
      <NodeAutoSync />
      <Toaster theme="dark" position="bottom-center" />
      <div className="no-print flex h-dvh w-full min-w-0 flex-col overflow-hidden bg-bg text-fg">
        <div data-layout="desktop" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <DesktopHeader locale={locale} setLocale={setLocale} languageLabel={t("header.language")} />
          <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
            <DesktopStudio />
          </div>
        </div>
        <div data-layout="mobile" className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
          <AndroidStudio locale={locale} setLocale={setLocale} />
        </div>
      </div>
      <RecoveryPrintRoot />
    </TooltipProvider>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function readWidth(key: string, fallback: number) {
  try {
    const n = Number(localStorage.getItem(key));
    if (Number.isFinite(n)) return n;
  } catch {
    /* ignore */
  }
  return fallback;
}

function usePaneWidth(key: string, fallback: number, min: number, max: number) {
  const [width, setWidth] = useState(fallback);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setWidth(clamp(readWidth(key, fallback), min, max));
  }, [key, fallback, min, max]);

  const onDrag = useCallback(
    (e: ReactPointerEvent, dir: 1 | -1) => {
      e.preventDefault();
      const el = ref.current;
      if (!el) return;
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const next = Math.round(clamp(startW + dir * (ev.clientX - startX), min, max));
        el.style.width = `${next}px`;
      };
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        const next = Math.round(clamp(startW + dir * (ev.clientX - startX), min, max));
        el.style.width = `${next}px`;
        setWidth(next);
        try {
          localStorage.setItem(key, String(next));
        } catch {
          /* ignore */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    },
    [key, min, max],
  );

  return { width, ref, onDrag };
}

function usePaneOpen(key: string, fallback = true) {
  const [open, setOpen] = useState(fallback);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v === "0") setOpen(false);
      if (v === "1") setOpen(true);
    } catch {
      /* ignore */
    }
  }, [key]);
  const toggle = useCallback(() => {
    setOpen((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [key]);
  return [open, toggle] as const;
}

function PaneToggle({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-fg-muted hover:bg-muted hover:text-fg"
    >
      {children}
    </button>
  );
}

function DesktopStudio() {
  const { t } = useT();
  const expert = useStudio((s) => s.mode) === "expert";
  const [tab, setTab] = useState("stages");
  const left = usePaneWidth("scriptwerk-left-w", 300, 240, 560);
  const right = usePaneWidth("scriptwerk-right-w", 340, 260, 520);
  const [leftOpen, toggleLeft] = usePaneOpen("scriptwerk-left-on");
  const [rightOpen, toggleRight] = usePaneOpen("scriptwerk-right-on");

  useEffect(() => {
    if (!expert && tab === "ops") setTab("stages");
  }, [expert, tab]);

  return (
    <>
      {leftOpen ? (
        <aside
          ref={left.ref}
          style={{ width: left.width }}
          className="relative flex shrink-0 flex-col overflow-hidden border-r border-border"
        >
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 px-2 pt-3">
              <TabsList className="min-w-0 flex-1">
                <TabsTrigger value="stages" className="flex-1 px-1.5 text-xs">
                  {t("tabs.stages")}
                </TabsTrigger>
                <TabsTrigger value="keys" className="flex-1 px-1.5 text-xs">
                  {t("tabs.keys")}
                </TabsTrigger>
                {expert ? (
                  <TabsTrigger value="ops" className="flex-1 px-1.5 text-xs">
                    {t("tabs.expert")}
                  </TabsTrigger>
                ) : null}
              </TabsList>
              <PaneToggle label={t("pane.hideLeft")} onClick={toggleLeft}>
                <ChevronsLeft className="size-4" />
              </PaneToggle>
            </div>
            <TabsContent
              value="stages"
              className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
            >
              <StageBuilder />
            </TabsContent>
            <TabsContent
              value="keys"
              className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
            >
              <KeyBoard fill />
            </TabsContent>
            {expert ? (
              <TabsContent
                value="ops"
                className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=active]:flex data-[state=active]:flex-col"
              >
                <ExpertPanel pinInspector />
              </TabsContent>
            ) : null}
          </Tabs>
          <button
            type="button"
            aria-label={t("pane.resize")}
            className="absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-border-strong"
            onPointerDown={(e) => left.onDrag(e, 1)}
          />
        </aside>
      ) : (
        <aside className="flex w-11 shrink-0 flex-col items-center border-r border-border pt-3">
          <PaneToggle label={t("pane.showLeft")} onClick={toggleLeft}>
            <ChevronsRight className="size-4" />
          </PaneToggle>
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-ink">
        <PolicyGraph />
      </main>
      {rightOpen ? (
        <aside
          ref={right.ref}
          style={{ width: right.width }}
          className="relative flex shrink-0 flex-col overflow-hidden border-l border-border"
        >
          <button
            type="button"
            aria-label={t("pane.resize")}
            className="absolute top-0 left-0 z-20 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-border-strong"
            onPointerDown={(e) => right.onDrag(e, -1)}
          />
          <InterpreterPanel
            toolbarStart={
              <PaneToggle label={t("pane.hideRight")} onClick={toggleRight}>
                <ChevronsRight className="size-4" />
              </PaneToggle>
            }
          />
        </aside>
      ) : (
        <aside className="flex w-11 shrink-0 flex-col items-center border-l border-border pt-3">
          <PaneToggle label={t("pane.showRight")} onClick={toggleRight}>
            <ChevronsLeft className="size-4" />
          </PaneToggle>
        </aside>
      )}
    </>
  );
}

function DesktopHeader({
  locale,
  setLocale,
  languageLabel,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  languageLabel: string;
}) {
  return (
    <header className="relative z-30 shrink-0 border-b border-border bg-ink" style={{ touchAction: "manipulation" }}>
      <div className="relative h-[7.25rem] w-full overflow-hidden">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-[11.5rem] overflow-hidden">
          <img
            src="/miniscript-banner.jpg?v=5"
            alt=""
            className="h-full w-auto max-w-none object-cover object-left"
          />
        </div>
        <div className="absolute top-2 right-4 z-10 text-right">
          <p className="font-display text-[1.95rem] font-semibold tracking-[0.24em] text-fg">SCRIPTWERK</p>
          <p className="mt-0.5 text-[0.72rem] font-medium tracking-[0.36em] text-fg-muted uppercase">
            Miniscript Studio
          </p>
        </div>
        <div className="absolute right-4 bottom-2 z-20 flex flex-wrap items-center justify-end gap-2">
          <ImportExportBar />
          <ModeSwitch />
          <LangSwitch locale={locale} setLocale={setLocale} label={languageLabel} />
        </div>
      </div>
      <h1 className="sr-only">Scriptwerk — Miniscript Studio</h1>
    </header>
  );
}

function AndroidStudio({
  locale,
  setLocale,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
}) {
  const { t } = useT();
  const expert = useStudio((s) => s.mode) === "expert";
  const selectedStageId = useStudio((s) => s.selectedStageId);
  const [tab, setTab] = useState("stages");
  const prevStage = useRef<string | null>(null);

  useEffect(() => {
    if (selectedStageId && selectedStageId !== prevStage.current) setTab("tree");
    prevStage.current = selectedStageId;
  }, [selectedStageId]);

  useEffect(() => {
    if (!expert && tab === "ops") setTab("stages");
  }, [expert, tab]);

  const items = [
    { id: "stages", label: t("tabs.stages"), icon: Layers },
    { id: "tree", label: t("tabs.tree"), icon: GitFork },
    { id: "keys", label: t("tabs.keys"), icon: KeyRound },
    ...(expert ? [{ id: "ops", label: t("tabs.expert"), icon: SlidersHorizontal }] : []),
    { id: "read", label: t("tabs.read"), icon: FileCode2 },
  ];

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-bg">
      <header
        className="shrink-0 border-b border-border bg-ink"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-2 px-3 pb-1.5">
          <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-display text-[0.95rem] font-semibold tracking-[0.18em] text-fg">SCRIPTWERK</p>
            <p className="text-[0.58rem] font-medium tracking-[0.22em] text-fg-muted uppercase">
              {t("android.subtitle")}
            </p>
          </div>
          <LangSwitch locale={locale} setLocale={setLocale} label={t("header.language")} />
        </div>
        <div className="android-actions overflow-x-auto px-3 pb-2">
          <div className="flex items-center gap-1.5">
            <ModeSwitch />
            <ImportExportBar />
          </div>
        </div>
        <h1 className="sr-only">Scriptwerk — Miniscript Studio</h1>
      </header>
      <AndroidInstallBanner />
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {tab === "stages" ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden px-3 pt-2">
            <StageBuilder />
          </div>
        ) : null}
        {tab === "tree" ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden pt-2">
            <PolicyGraph />
          </div>
        ) : null}
        {tab === "keys" ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden px-3 pt-2">
            <KeyBoard fill />
          </div>
        ) : null}
        {tab === "ops" && expert ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <ExpertPanel />
          </div>
        ) : null}
        {tab === "read" ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <InterpreterPanel />
          </div>
        ) : null}
      </div>
      <nav
        className="android-nav z-30 shrink-0 border-t border-border bg-surface"
        role="tablist"
        aria-label={t("android.nav")}
      >
        {items.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className={
                active
                  ? "flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-primary"
                  : "flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-fg-muted"
              }
            >
              <span
                className={
                  active
                    ? "inline-flex h-8 w-14 items-center justify-center rounded-full bg-primary/15"
                    : "inline-flex h-8 w-14 items-center justify-center rounded-full"
                }
              >
                <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
              </span>
              <span className="max-w-full truncate px-0.5 text-[0.65rem] font-medium tracking-wide">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function ExpertPanel({ pinInspector = false }: { pinInspector?: boolean }) {
  const { t } = useT();

  const settings = (
    <div className="space-y-3 px-4 pt-4 pb-3">
      <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("tabs.expert")}</p>
      <p className="text-xs text-pretty text-fg-muted">{t("expert.blurb")}</p>
      <ExpertPolicySettings />
      <KeyReuseControls />
    </div>
  );

  if (pinInspector) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {settings}
          <div className="border-t border-border">
            <OperatorPalette embedded />
          </div>
        </div>
        <div className="shrink-0 border-t border-border">
          <NodeInspector />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {settings}
        <div className="border-t border-border">
          <OperatorPalette embedded />
        </div>
        <div className="border-t border-border">
          <NodeInspector />
        </div>
      </div>
    </div>
  );
}

function ModeSwitch() {
  const { t } = useT();
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);
  return (
    <div role="group" aria-label={t("header.mode")} className="flex shrink-0 flex-wrap gap-1.5">
      {(["easy", "expert"] as const).map((code) => (
        <button
          key={code}
          type="button"
          aria-pressed={mode === code}
          onClick={() => setMode(code)}
          className={
            mode === code
              ? "h-9 rounded-full bg-primary px-2.5 text-2xs tracking-wide text-primary-foreground"
              : "h-9 rounded-full border border-border px-2.5 text-2xs tracking-wide text-fg-muted hover:bg-muted hover:text-fg"
          }
        >
          {t(`header.${code}`)}
        </button>
      ))}
    </div>
  );
}

function LangSwitch({
  locale,
  setLocale,
  label,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 flex-wrap gap-1.5">
      {(["de", "en"] as const).map((code) => (
        <button
          key={code}
          type="button"
          aria-pressed={locale === code}
          onClick={() => setLocale(code)}
          className={
            locale === code
              ? "h-9 min-w-9 rounded-full bg-primary px-2.5 font-mono text-2xs tracking-wide text-primary-foreground"
              : "h-9 min-w-9 rounded-full border border-border px-2.5 font-mono text-2xs tracking-wide text-fg-muted hover:bg-muted hover:text-fg"
          }
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

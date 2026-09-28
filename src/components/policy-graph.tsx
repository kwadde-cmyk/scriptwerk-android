import { memo, useEffect, useMemo, useState } from "react";
import { layoutTree } from "@/lib/miniscript/layout";
import { visit, type MsNode } from "@/lib/miniscript/ast";
import { evaluateCoinStatus } from "@/lib/miniscript/coin-status";
import { lockWhen, tokenNeedsAction, type KeyEntry } from "@/lib/miniscript/keys";
import { describeStageSlots, stageHighlightIds, stageLockOf } from "@/lib/miniscript/stages";
import { useBitcoind } from "@/store/bitcoind";
import { useStudio } from "@/store/studio";
import { PolicyNameHeading } from "@/components/policy-title";
import { ZoomPane } from "@/components/zoom-pane";
import { Button } from "@/components/ui/button";
import { GitBranch, Lock, Unlock } from "lucide-react";
import { useT } from "@/lib/use-t";

function attentionIds(root: MsNode | null, keys: KeyEntry[], reuse: boolean): Set<string> {
  const ids = new Set<string>();
  if (!root) return ids;
  visit(root, (n) => {
    if (n.kind === "hole") ids.add(n.id);
    if (n.kind === "pk" || n.kind === "pkh") {
      if (tokenNeedsAction(n.key, keys, reuse)) ids.add(n.id);
    }
    if (n.kind === "multi" && n.keys.some((k) => tokenNeedsAction(k, keys, reuse))) {
      ids.add(n.id);
    }
  });
  return ids;
}

export const PolicyGraph = memo(function PolicyGraph() {
  const { t, locale } = useT();
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedStageId = useStudio((s) => s.selectedStageId);
  const select = useStudio((s) => s.select);
  const layout = useMemo(() => layoutTree(root, locale), [root, locale]);
  const attention = useMemo(() => attentionIds(root, keys, reuseKeys), [root, keys, reuseKeys]);
  const highlight = useMemo(
    () => stageHighlightIds(root, stages, selectedStageId),
    [root, stages, selectedStageId],
  );
  const slots = useMemo(() => describeStageSlots(stages, reuseKeys), [stages, reuseKeys]);
  const unspents = useBitcoind((s) => s.lastWatch?.unspents);
  const tip = useBitcoind((s) => (s.probe && s.probe.chain !== "demo" ? s.probe.blocks : 0)) ?? 0;
  const [locks, setLocks] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("scriptwerk-graph-locks") === "1") setLocks(true);
    } catch {
      /* ignore */
    }
  }, []);
  const opens = useMemo(() => {
    if (!slots.length) return [] as boolean[];
    const live = (unspents ?? []).filter((c) => c.height > 0);
    if (live.length) {
      const chain = tip || Math.max(...live.map((c) => c.height));
      const flags = slots.map(() => false);
      for (const coin of live) {
        const paths = evaluateCoinStatus({ height: coin.height, tip: chain, stages, reuse: reuseKeys, root }).paths;
        paths.forEach((p, i) => {
          if (p.open) flags[i] = true;
        });
      }
      return flags;
    }
    if (tip > 0) return evaluateCoinStatus({ height: tip, tip, stages, reuse: reuseKeys, root }).paths.map((p) => p.open);
    return slots.map((slot) => slot.lock !== "after" && slot.delay <= 0);
  }, [slots, unspents, tip, stages, reuseKeys, root]);
  const branchIds = useMemo(() => slots.map((slot) => stageHighlightIds(root, stages, slot.id)), [slots, root, stages]);
  function toneOf(id: string): "open" | "locked" | null {
    if (!locks) return null;
    let open = false;
    let locked = false;
    branchIds.forEach((ids, i) => {
      if (!ids.has(id)) return;
      if (opens[i]) open = true;
      else locked = true;
    });
    if (open === locked) return null;
    return open ? "open" : "locked";
  }
  const stageIndex = selectedStageId ? stages.findIndex((s) => s.id === selectedStageId) : -1;
  const activeStage = stageIndex >= 0 ? stages[stageIndex] : null;
  const selectedRect = useMemo(() => {
    const boxes = highlight.size
      ? layout.boxes.filter((box) => highlight.has(box.id))
      : layout.boxes.filter((box) => box.id === selectedId);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const r = Math.max(...boxes.map((b) => b.x + b.w));
    const btm = Math.max(...boxes.map((b) => b.y + b.h));
    return { x, y, w: r - x, h: btm - y };
  }, [layout.boxes, selectedId, highlight]);

  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-ink px-4 py-2">
        <h2 className="min-w-0 truncate font-display text-lg tracking-tight text-fg">
          <PolicyNameHeading />
        </h2>
        {activeStage ? (
          <div className="shrink-0 rounded-full bg-primary px-3 py-1 font-mono text-2xs text-primary-foreground">
            {t("graph.stagePath", { n: stageIndex + 1 })}
            <span className="ml-2 opacity-80">{lockWhen(stageLockOf(activeStage), activeStage.delay, locale)}</span>
          </div>
        ) : null}
      </div>
      {root ? (
        <ZoomPane
          contentWidth={Math.max(layout.width, 320)}
          contentHeight={Math.max(layout.height, 240)}
          selectedRect={selectedRect}
          toolbar={
            <Button
              type="button"
              variant={locks ? "default" : "outline"}
              size="icon"
              className="size-9"
              aria-pressed={locks}
              aria-label={t("graph.locks")}
              onClick={() =>
                setLocks((v) => {
                  const next = !v;
                  try {
                    localStorage.setItem("scriptwerk-graph-locks", next ? "1" : "0");
                  } catch {
                    /* ignore */
                  }
                  return next;
                })
              }
            >
              {locks ? <Unlock /> : <Lock />}
            </Button>
          }
        >
          <svg
            width={Math.max(layout.width, 320)}
            height={Math.max(layout.height, 240)}
            className="block"
            role="img"
            aria-label={t("graph.aria")}
          >
            {layout.edges.map((e) => {
              const midY = (e.y1 + e.y2) / 2;
              const hot = highlight.size > 0;
              const on = !hot || (highlight.has(e.from) && highlight.has(e.to));
              const edgeTone = toneOf(e.to);
              const edgeStroke =
                edgeTone === "open"
                  ? "var(--color-ok)"
                  : edgeTone === "locked"
                    ? "var(--color-danger)"
                    : on && hot
                      ? "var(--color-primary)"
                      : "var(--color-border-strong)";
              return (
                <g key={`${e.from}-${e.to}`} opacity={on ? 1 : 0.22}>
                  <path
                    d={`M ${e.x1} ${e.y1} L ${e.x1} ${midY} L ${e.x2} ${midY} L ${e.x2} ${e.y2}`}
                    fill="none"
                    stroke={edgeStroke}
                    strokeWidth={edgeTone || (on && hot) ? 1.75 : 1.25}
                  />
                  {e.label ? (
                    <text
                      x={(e.x1 + e.x2) / 2}
                      y={midY - 4}
                      textAnchor="middle"
                      fill="var(--color-fg-subtle)"
                      fontSize={9}
                      fontFamily="IBM Plex Sans, system-ui, sans-serif"
                    >
                      {e.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {layout.boxes.map((b) => {
              const selected = b.id === selectedId;
              const compact = b.h < 40;
              const timeish = b.kind === "older" || b.kind === "after";
              const needs = attention.has(b.id);
              const hot = highlight.size > 0;
              const lit = highlight.has(b.id);
              const tone = toneOf(b.id);
              const fill = b.hole
                ? "transparent"
                : selected && !lit
                  ? "var(--color-primary)"
                  : tone === "open"
                    ? "color-mix(in srgb, var(--color-ok) 42%, var(--color-elevated))"
                    : tone === "locked"
                      ? "color-mix(in srgb, var(--color-danger) 36%, var(--color-elevated))"
                      : lit
                        ? "color-mix(in srgb, var(--color-primary) 38%, var(--color-elevated))"
                        : needs
                          ? "color-mix(in srgb, var(--color-danger) 16%, var(--color-elevated))"
                          : "var(--color-elevated)";
              const stroke =
                tone === "open"
                  ? "var(--color-ok)"
                  : tone === "locked"
                    ? "var(--color-danger)"
                    : lit
                      ? "var(--color-primary)"
                      : needs
                        ? "var(--color-danger)"
                        : b.hole
                          ? "var(--color-fg-subtle)"
                          : selected
                            ? "var(--color-primary)"
                            : timeish
                              ? "var(--color-warn)"
                              : "var(--color-border-strong)";
              const titleFill =
                selected && !lit && !b.hole
                  ? "var(--color-primary-foreground)"
                  : tone || lit
                    ? "var(--color-fg)"
                    : needs
                      ? "var(--color-danger)"
                      : "var(--color-fg)";
              const subFill =
                selected && !lit && !b.hole
                  ? "var(--color-primary-foreground)"
                  : needs && !tone
                    ? "var(--color-danger)"
                    : "var(--color-fg-muted)";
              return (
                <g key={b.id} transform={`translate(${b.x} ${b.y})`} opacity={!hot || lit ? 1 : 0.22}>
                  <rect
                    width={b.w}
                    height={b.h}
                    rx={compact ? 6 : 10}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={tone ? 2 : lit ? 2.4 : needs || selected ? 1.75 : 1}
                    strokeDasharray={b.hole ? "4 3" : undefined}
                    onClick={() => select(b.id)}
                    style={{ cursor: "pointer" }}
                  />
                  <text
                    x={b.w / 2}
                    y={compact ? b.h / 2 + 4 : 22}
                    textAnchor="middle"
                    fill={titleFill}
                    fontSize={compact ? 11 : 12}
                    fontFamily="IBM Plex Mono, ui-monospace, monospace"
                    style={{ pointerEvents: "none" }}
                  >
                    {b.title}
                  </text>
                  {!compact && b.subtitle ? (
                    <text
                      x={b.w / 2}
                      y={42}
                      textAnchor="middle"
                      fill={subFill}
                      fontSize={10}
                      fontFamily="IBM Plex Sans, system-ui, sans-serif"
                      opacity={0.85}
                      style={{ pointerEvents: "none" }}
                    >
                      {b.subtitle.length > 28 ? `${b.subtitle.slice(0, 26)}…` : b.subtitle}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        </ZoomPane>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitBranch className="size-8 text-fg-subtle" strokeWidth={1.25} />
          <div>
            <p className="font-display text-lg tracking-tight">{t("graph.empty")}</p>
            <p className="mt-1 max-w-sm text-sm text-pretty text-fg-muted">{t("graph.emptyBlurb")}</p>
          </div>
        </div>
      )}
    </div>
  );
});

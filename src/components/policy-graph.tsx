import { memo, useMemo } from "react";
import { layoutTree } from "@/lib/miniscript/layout";
import { visit, type MsNode } from "@/lib/miniscript/ast";
import { lockWhen, tokenNeedsAction, type KeyEntry } from "@/lib/miniscript/keys";
import { stageHighlightIds, stageLockOf } from "@/lib/miniscript/stages";
import { useStudio } from "@/store/studio";
import { PolicyNameHeading } from "@/components/policy-title";
import { ZoomPane } from "@/components/zoom-pane";
import { GitBranch } from "lucide-react";
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
              return (
                <g key={`${e.from}-${e.to}`} opacity={on ? 1 : 0.22}>
                  <path
                    d={`M ${e.x1} ${e.y1} L ${e.x1} ${midY} L ${e.x2} ${midY} L ${e.x2} ${e.y2}`}
                    fill="none"
                    stroke={on && hot ? "var(--color-primary)" : "var(--color-border-strong)"}
                    strokeWidth={on && hot ? 1.75 : 1.25}
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
              const fill = b.hole
                ? "transparent"
                : lit
                  ? "color-mix(in srgb, var(--color-primary) 38%, var(--color-elevated))"
                  : selected
                    ? "var(--color-primary)"
                    : needs
                      ? "color-mix(in srgb, var(--color-danger) 16%, var(--color-elevated))"
                      : "var(--color-elevated)";
              const stroke = lit
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
                  : lit
                    ? "var(--color-fg)"
                    : needs
                      ? "var(--color-danger)"
                      : "var(--color-fg)";
              const subFill =
                selected && !lit && !b.hole
                  ? "var(--color-primary-foreground)"
                  : lit
                    ? "var(--color-fg-muted)"
                    : needs
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
                    strokeWidth={lit ? 2.4 : needs || selected ? 1.75 : 1}
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

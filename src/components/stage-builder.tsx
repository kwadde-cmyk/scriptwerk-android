import { delayPresets, defaultStages, nextStageDelay, sortedMultiAllowed, stageFormula, type Stage } from "@/lib/miniscript/stages";
import { blocksWhen, keyIsFilled, nextKeyName, type KeyEntry } from "@/lib/miniscript/keys";
import { uid } from "@/lib/utils";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "@/lib/use-t";
import { Minus, Plus, Trash2 } from "lucide-react";

export function StageBuilder() {
  const { t } = useT();
  const stages = useStudio((s) => s.stages);
  const keys = useStudio((s) => s.keys);
  const setStages = useStudio((s) => s.setStages);
  const selectedStageId = useStudio((s) => s.selectedStageId);
  const selectStage = useStudio((s) => s.selectStage);
  const maxOlder = useStudio((s) => s.maxOlder);
  const expert = useStudio((s) => s.mode) === "expert";

  const allowSorted = sortedMultiAllowed(stages);
  const pool = keys.map((k) => k.name);

  function patch(id: string, fn: (s: Stage) => Stage) {
    setStages(stages.map((s) => (s.id === id ? fn(s) : s)));
  }

  function addStage() {
    if (!stages.length) {
      setStages(defaultStages());
      return;
    }
    const delay = nextStageDelay(stages, maxOlder);
    const prev = stages[stages.length - 1];
    const names = prev?.keys.length ? [...prev.keys] : pool.slice(0, 3);
    const extra = nextKeyName([...pool, ...names]);
    names.push(extra);
    setStages([
      ...stages.map((s) => ({ ...s, sorted: false })),
      {
        id: uid("st"),
        delay,
        k: Math.min(prev?.k ?? 2, names.length),
        keys: names,
      },
    ]);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-2">
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("stages.title")}</p>
        <p className="mt-1 text-xs text-pretty text-fg-muted">{t(expert ? "stages.blurb" : "stages.blurbEasy")}</p>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-3 pb-4">
        <div className="space-y-3">
          {stages.length === 0 ? (
            <p className="px-1 text-xs text-fg-muted">{t("stages.empty")}</p>
          ) : null}
          {stages
            .slice()
            .sort((a, b) => a.delay - b.delay)
            .map((s, i) => (
              <StageCard
                key={s.id}
                index={i}
                stage={s}
                pool={pool}
                entries={keys}
                canRemove={stages.length > 1}
                allowSorted={allowSorted}
                expert={expert}
                maxOlder={maxOlder}
                selected={selectedStageId === s.id}
                onSelect={() => selectStage(s.id)}
                onChange={(next) => patch(s.id, () => next)}
                onRemove={() => setStages(stages.filter((x) => x.id !== s.id))}
              />
            ))}
          <Button variant="outline" className="w-full" onClick={addStage}>
            <Plus /> {stages.length ? t("stages.addLocked") : t("stages.add")}
          </Button>
        </div>
      </ScrollArea>
    </div>
  );
}

export function ExpertPolicySettings() {
  const { t } = useT();
  const stages = useStudio((s) => s.stages);
  const nesting = useStudio((s) => s.nesting);
  const setNesting = useStudio((s) => s.setNesting);
  const maxOlder = useStudio((s) => s.maxOlder);
  const setMaxOlder = useStudio((s) => s.setMaxOlder);
  return (
    <div className="space-y-3">
      <div>
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("stages.maxOlder")}</p>
        <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t("stages.maxOlderHint")}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={maxOlder === 65534}
            onClick={() => setMaxOlder(65534)}
            className={
              maxOlder === 65534
                ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground"
                : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
            }
          >
            65534
          </button>
          <button
            type="button"
            aria-pressed={maxOlder === 65535}
            onClick={() => setMaxOlder(65535)}
            className={
              maxOlder === 65535
                ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground"
                : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
            }
          >
            65535
          </button>
        </div>
      </div>
      {stages.length > 1 ? (
        <div>
          <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("stages.nest")}</p>
          <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t("stages.nestHint")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={nesting === "late"}
              onClick={() => setNesting("late")}
              className={
                nesting === "late"
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("stages.nestLate")}
            </button>
            <button
              type="button"
              aria-pressed={nesting === "early"}
              onClick={() => setNesting("early")}
              className={
                nesting === "early"
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("stages.nestEarly")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StageCard({
  index,
  stage,
  pool,
  entries,
  canRemove,
  allowSorted,
  expert,
  maxOlder,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  index: number;
  stage: Stage;
  pool: string[];
  entries: KeyEntry[];
  canRemove: boolean;
  allowSorted: boolean;
  expert: boolean;
  maxOlder: number;
  selected: boolean;
  onSelect: () => void;
  onChange: (s: Stage) => void;
  onRemove: () => void;
}) {
  const { t, locale } = useT();
  const n = stage.keys.length;
  const k = Math.min(Math.max(stage.k, 1), Math.max(n, 1));
  const byName = new Map(entries.map((e) => [e.name, e]));

  function setN(nextN: number) {
    const count = Math.max(1, Math.min(15, nextN));
    let keys = [...stage.keys];
    const used = [...pool, ...keys];
    while (keys.length < count) {
      const name = nextKeyName(used);
      keys.push(name);
      used.push(name);
    }
    if (keys.length > count) keys = keys.slice(0, count);
    const required = (stage.required ?? []).filter((x) => keys.includes(x));
    onChange({
      ...stage,
      keys,
      k: Math.min(k, keys.length),
      required: required.length ? required : undefined,
    });
  }

  function toggleKey(name: string) {
    const has = stage.keys.includes(name);
    const keys = has ? stage.keys.filter((x) => x !== name) : [...stage.keys, name];
    if (!keys.length) return;
    const required = (stage.required ?? []).filter((k) => keys.includes(k));
    onChange({
      ...stage,
      keys,
      k: Math.min(Math.max(k, 1), keys.length),
      required: required.length && k < keys.length ? required : undefined,
    });
  }

  function toggleRequired(name: string) {
    if (!stage.keys.includes(name) || n < 2) return;
    const cur = stage.required ?? [];
    const on = cur.includes(name);
    let required = on ? cur.filter((x) => x !== name) : [...cur, name];
    required = required.filter((x) => stage.keys.includes(x));
    let nextK = k;
    if (required.length && nextK <= required.length) {
      nextK = Math.min(n, required.length + 1);
    }
    if (nextK >= n) {
      onChange({ ...stage, k: nextK, required: undefined, sorted: false });
      return;
    }
    onChange({
      ...stage,
      k: nextK,
      required: required.length ? required : undefined,
      sorted: required.length ? false : stage.sorted,
    });
  }

  function moveKey(name: string, dir: -1 | 1) {
    const i = stage.keys.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= stage.keys.length) return;
    const keys = [...stage.keys];
    const tmp = keys[i]!;
    keys[i] = keys[j]!;
    keys[j] = tmp;
    onChange({ ...stage, keys });
  }

  const shown = [...stage.keys, ...pool.filter((n) => !stage.keys.includes(n))];

  return (
    <article
      data-stage-id={stage.id}
      className={`rounded-xl border p-2.5 ${
        selected ? "border-primary bg-primary/15 ring-1 ring-primary" : "border-border bg-surface"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="min-w-0 flex-1 rounded-lg px-0.5 py-0.5 text-left hover:bg-muted/40"
        >
          <span className="block text-sm font-medium">
            {t("stages.n", { n: index + 1 })}
            <span className="ml-2 text-xs font-normal text-fg-muted">{blocksWhen(stage.delay, locale)}</span>
          </span>
          <span className="mt-1 block font-mono text-2xs text-fg-muted">{stageFormula(stage)}</span>
        </button>
        {canRemove ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            type="button"
            onClick={onRemove}
            aria-label={t("stages.remove")}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3" onClick={(e) => e.stopPropagation()}>
        <Stepper label={t("stages.keys")} value={n} min={1} max={15} onChange={setN} />
        <Stepper
          label={t("stages.threshold")}
          value={k}
          min={1}
          max={Math.max(n, 1)}
          onChange={(v) =>
            onChange({ ...stage, k: v, required: v < n ? stage.required : undefined, andv: v >= n ? stage.andv : undefined })
          }
        />
      </div>

      <div className="mt-3" onClick={(e) => e.stopPropagation()}>
        <Label>{t("stages.inStage")}</Label>
        <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t(expert ? "stages.keyHint" : "stages.keyHintEasy")}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {shown.map((name) => {
            const on = stage.keys.includes(name);
            const must = Boolean(expert && on && k < n && stage.required?.includes(name));
            const entry = byName.get(name);
            const filled = entry ? keyIsFilled(entry) : false;
            const idx = stage.keys.indexOf(name);
            return (
              <span key={name} className="inline-flex items-center">
                {expert && on && idx > 0 ? (
                  <button
                    type="button"
                    className="h-9 w-7 rounded-l-full bg-primary/85 text-primary-foreground hover:bg-primary"
                    aria-label={t("stages.moveLeft")}
                    onClick={() => moveKey(name, -1)}
                  >
                    ‹
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleKey(name)}
                  className={
                    on
                      ? `h-9 bg-primary px-3 font-mono text-xs text-primary-foreground ${
                          expert && idx > 0 ? "" : "rounded-l-full"
                        } ${expert && idx >= 0 && idx < n - 1 ? "" : "rounded-r-full"}`
                      : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
                  }
                >
                  {name}
                  {must ? <span className="ml-1 opacity-80">*</span> : null}
                  {filled ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-current opacity-80" /> : null}
                </button>
                {expert && on && idx >= 0 && idx < n - 1 ? (
                  <button
                    type="button"
                    className="h-9 w-7 rounded-r-full bg-primary/85 text-primary-foreground hover:bg-primary"
                    aria-label={t("stages.moveRight")}
                    onClick={() => moveKey(name, 1)}
                  >
                    ›
                  </button>
                ) : null}
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setN(n + 1)}
            className="h-9 rounded-full border border-dashed border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
          >
            + Key
          </button>
        </div>
        {expert && allowSorted ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={!stage.sorted}
              onClick={() => onChange({ ...stage, sorted: false })}
              className={
                !stage.sorted
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("stages.unsorted")}
            </button>
            <button
              type="button"
              aria-pressed={Boolean(stage.sorted)}
              onClick={() => onChange({ ...stage, sorted: true })}
              className={
                stage.sorted
                  ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("stages.sorted")}
            </button>
          </div>
        ) : null}
      </div>

      {expert ? (
      <div className="mt-3" onClick={(e) => e.stopPropagation()}>
        <Label>{t("stages.pubkey")}</Label>
        <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t("stages.pkHint")}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={!stage.hash}
            onClick={() => onChange({ ...stage, hash: false })}
            className={
              !stage.hash
                ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground"
                : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
            }
          >
            pk
          </button>
          <button
            type="button"
            aria-pressed={Boolean(stage.hash)}
            onClick={() => onChange({ ...stage, hash: true, sorted: false, andv: false })}
            className={
              stage.hash
                ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground"
                : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
            }
          >
            pkh
          </button>
        </div>
      </div>
      ) : null}

      {expert && n >= 2 && k >= n && !stage.hash ? (
        <div className="mt-3" onClick={(e) => e.stopPropagation()}>
          <Label>{t("stages.andv")}</Label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={!stage.andv}
              onClick={() => onChange({ ...stage, andv: false })}
              className={
                !stage.andv
                  ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("stages.asMulti")}
            </button>
            <button
              type="button"
              aria-pressed={Boolean(stage.andv)}
              onClick={() => onChange({ ...stage, andv: true, sorted: false })}
              className={
                stage.andv
                  ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground"
                  : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t("stages.asAndv")}
            </button>
          </div>
        </div>
      ) : null}

      {expert && n >= 2 ? (
      <div className="mt-3" onClick={(e) => e.stopPropagation()}>
        <Label>{t("stages.mustRow")}</Label>
        {k >= n ? (
          <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t("stages.mustAll")}</p>
        ) : (
          <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t("stages.mustRowHint")}</p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {stage.keys.map((name) => {
            const on = k >= n || Boolean(stage.required?.includes(name));
            return (
              <button
                key={`must-${name}`}
                type="button"
                disabled={k >= n}
                aria-pressed={on}
                onClick={() => toggleRequired(name)}
                className={
                  on
                    ? "h-9 rounded-full bg-primary px-3 font-mono text-xs text-primary-foreground disabled:opacity-90"
                    : "h-9 rounded-full border border-border px-3 font-mono text-xs text-fg-muted hover:bg-muted hover:text-fg"
                }
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
      ) : null}

      <div className="mt-3" onClick={(e) => e.stopPropagation()}>
        <Label htmlFor={`delay-${stage.id}`}>{t("stages.timelock")}</Label>
        <Input
          id={`delay-${stage.id}`}
          type="number"
          min={0}
          max={maxOlder}
          value={stage.delay}
          onChange={(e) => {
            const delay = Math.max(0, Math.min(maxOlder, Number(e.target.value) || 0));
            onChange({ ...stage, delay, sorted: delay > 0 ? false : stage.sorted });
          }}
          className="mt-1.5 font-mono"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {delayPresets(maxOlder).map((nDelay) => (
            <button
              key={nDelay}
              type="button"
              onClick={() => onChange({ ...stage, delay: nDelay, sorted: nDelay > 0 ? false : stage.sorted })}
              className={
                stage.delay === nDelay
                  ? "h-8 rounded-full bg-muted px-2.5 text-2xs text-fg"
                  : "h-8 rounded-full border border-border px-2.5 text-2xs text-fg-muted hover:bg-muted hover:text-fg"
              }
            >
              {t(`delay.${nDelay}`)}
            </button>
          ))}
        </div>
      </div>
    </article>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const { t } = useT();
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5 flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 shrink-0"
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
          aria-label={t("stages.dec", { label })}
        >
          <Minus />
        </Button>
        <span className="flex h-10 min-w-10 flex-1 items-center justify-center font-mono text-sm tabular-nums">
          {value}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 shrink-0"
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          aria-label={t("stages.inc", { label })}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

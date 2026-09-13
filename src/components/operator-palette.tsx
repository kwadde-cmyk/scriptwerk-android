import { useMemo, useState } from "react";
import { OPERATORS, WRAPPERS, type OperatorDef } from "@/lib/miniscript/operators";
import { delayPresets } from "@/lib/miniscript/stages";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/use-t";
import { Plus, Minus } from "lucide-react";

export function OperatorPalette({ embedded = false }: { embedded?: boolean }) {
  const { t } = useT();
  const applyOperator = useStudio((s) => s.applyOperator);
  const wrapSelected = useStudio((s) => s.wrapSelected);
  const keys = useStudio((s) => s.keys);
  const [pending, setPending] = useState<OperatorDef | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, OperatorDef[]>();
    for (const op of OPERATORS) {
      const list = map.get(op.group) ?? [];
      list.push(op);
      map.set(op.group, list);
    }
    return [...map.entries()];
  }, []);

  function onPick(op: OperatorDef) {
    if (op.params.length === 0 && op.id !== "thresh") {
      applyOperator(op.id, {});
      return;
    }
    setPending(op);
  }

  const inner = (
        <div className="space-y-4">
          {groups.map(([group, ops]) => (
            <section key={group}>
              <h3 className="mb-1.5 px-1 text-2xs font-medium tracking-wide text-fg-subtle">
                {t(`group.${ops[0]!.group}`)}
              </h3>
              <div className="grid grid-cols-2 gap-1.5">
                {ops.map((op) => (
                  <Tooltip key={op.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={op.label}
                        onClick={() => onPick(op)}
                        className="rounded-lg border border-border bg-surface px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-muted"
                      >
                        <span className="block font-mono text-xs text-fg">{op.label}</span>
                        <span className="mt-0.5 block text-2xs leading-snug text-fg-muted">
                          {t(`op.${op.id}.summary`)}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t(`op.${op.id}.hint`)}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </section>
          ))}
          <section>
            <h3 className="mb-1.5 px-1 text-2xs font-medium tracking-wide text-fg-subtle">{t("ops.wrap")}</h3>
            <div className="flex flex-wrap gap-1.5">
              {WRAPPERS.map((w) => (
                <Tooltip key={w.code}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("ops.wrapAria", { code: w.code })}
                      onClick={() => wrapSelected(w.code)}
                      className="h-9 min-w-9 rounded-md border border-border bg-surface px-2 font-mono text-xs hover:bg-muted"
                    >
                      {w.code}:
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t(`wrap.${w.code}`)}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </section>
        </div>
  );

  return (
    <div className={embedded ? "" : "flex h-full flex-col"}>
      <div className="px-4 pt-4 pb-2">
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("ops.title")}</p>
        <p className="mt-1 text-xs text-fg-muted">{t("ops.blurb")}</p>
      </div>
      {embedded ? (
        <div className="px-3 pb-4">{inner}</div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 px-3 pb-4">{inner}</ScrollArea>
      )}
      {pending ? (
        <ParamDialog
          op={pending}
          keyNames={keys.map((k) => k.name)}
          onClose={() => setPending(null)}
          onApply={(params) => {
            applyOperator(pending.id, params);
            setPending(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ParamDialog({
  op,
  keyNames,
  onClose,
  onApply,
}: {
  op: OperatorDef;
  keyNames: string[];
  onClose: () => void;
  onApply: (p: { key?: string; keys?: string[]; n?: number; k?: number; childCount?: number }) => void;
}) {
  const { t } = useT();
  const maxOlder = useStudio((s) => s.maxOlder);
  const [key, setKey] = useState(keyNames[0] ?? "A");
  const [keys, setKeys] = useState<string[]>(
    keyNames.slice(0, 3).length ? keyNames.slice(0, 3) : ["A", "B", "C"],
  );
  const [n, setN] = useState(op.id === "older" ? 144 : 800000);
  const [k, setK] = useState(2);
  const [childCount, setChildCount] = useState(3);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono">{op.label}</DialogTitle>
          <DialogDescription>{t(`op.${op.id}.hint`)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {op.params.some((p) => p.kind === "key") ? (
            <Field label={t("ops.key")}>
              <KeySelect value={key} names={keyNames} onChange={setKey} />
            </Field>
          ) : null}
          {op.params.some((p) => p.kind === "keylist") ? (
            <Field label={t("ops.keyOrder")}>
              <div className="space-y-2">
                {keys.map((item, i) => (
                  <div key={i} className="flex gap-2">
                    <KeySelect
                      value={item}
                      names={keyNames}
                      onChange={(v) => setKeys(keys.map((x, j) => (j === i ? v : x)))}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-11 shrink-0"
                      onClick={() => setKeys(keys.filter((_, j) => j !== i))}
                      disabled={keys.length <= 2}
                    >
                      <Minus />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setKeys([...keys, keyNames[keys.length] ?? `K${keys.length + 1}`])}
                >
                  <Plus /> Key
                </Button>
              </div>
            </Field>
          ) : null}
          {op.params.some((p) => p.kind === "int") ? (
            <Field label={t("ops.threshold")}>
              <Input
                type="number"
                min={1}
                max={20}
                value={k}
                onChange={(e) => setK(Number(e.target.value))}
              />
            </Field>
          ) : null}
          {op.id === "thresh" ? (
            <Field label={t("ops.branches")}>
              <Input
                type="number"
                min={2}
                max={8}
                value={childCount}
                onChange={(e) => setChildCount(Number(e.target.value))}
              />
            </Field>
          ) : null}
          {op.params.some((p) => p.kind === "blocks") ? (
            <Field label={op.id === "older" ? t("ops.blocksCsv") : t("ops.heightCltv")}>
              <Input
                type="number"
                min={1}
                max={op.id === "older" ? maxOlder : 4294967295}
                value={n}
                onChange={(e) => setN(Number(e.target.value))}
              />
              {op.id === "older" ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {delayPresets(maxOlder).filter((v) => v > 0).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="h-8 rounded-full border border-border px-2.5 text-2xs text-fg-muted hover:bg-muted hover:text-fg"
                      onClick={() => setN(v)}
                    >
                      {v === 1 ? t("delay.block") : t(`delay.${v}`)}
                    </button>
                  ))}
                </div>
              ) : null}
            </Field>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              {t("ops.cancel")}
            </Button>
            <Button
              onClick={() =>
                onApply({
                  key,
                  keys,
                  n: op.id === "older" ? Math.max(1, Math.min(maxOlder, n)) : n,
                  k,
                  childCount,
                })
              }
            >
              {t("ops.insert")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function KeySelect({
  value,
  names,
  onChange,
}: {
  value: string;
  names: string[];
  onChange: (v: string) => void;
}) {
  return (
    <Input
      list="scriptwerk-keys"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono"
    />
  );
}

export function KeyDatalist() {
  const keys = useStudio((s) => s.keys);
  return (
    <datalist id="scriptwerk-keys">
      {keys.map((k) => (
        <option key={k.id} value={k.name} />
      ))}
    </datalist>
  );
}

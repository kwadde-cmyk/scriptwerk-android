import { useCallback, useRef, useState } from "react";
import {
  accountPathFrom,
  applyKeyMaterial,
  blocksWhen,
  childForAccount,
  childRoleLabel,
  keyIsFilled,
  keyNeedsAction,
  keyRoleLabel,
  nextUnusedAccount,
  normalizeKeyEntry,
  parseChildKey,
  parseAccountIndex,
  shortXpub,
  sortKeyEntries,
  type KeyEntry,
} from "@/lib/miniscript/keys";
import { isDerivedAlias, reuseAliasHints, slotsForAccount, type Stage, type StageSignerSlot } from "@/lib/miniscript/stages";
import { useStudio } from "@/store/studio";
import { FilePick, QrScanner } from "@/components/qr-io";
import { useHwFillKey } from "@/components/hardware-usb";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/use-t";
import { CopyButton, Copyable } from "@/components/copy-button";
import { KeyRound, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";

export function KeyBoard({ fill = false }: { fill?: boolean }) {
  const { t } = useT();
  const rawKeys = useStudio((s) => s.keys);
  const keys = rawKeys.map(normalizeKeyEntry);
  const stages = useStudio((s) => s.stages);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const removeUnusedKeys = useStudio((s) => s.removeUnusedKeys);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = keys.find((k) => k.id === detailsId) ?? null;
  const aliases = reuseAliasHints(stages, reuseKeys);
  const masters = new Set(stages.flatMap((s) => s.keys));
  const visible = sortKeyEntries(
    stages.length ? keys.filter((k) => !isDerivedAlias(k.name, masters)) : keys,
    stages,
  );
  const unusedCount = visible.filter((k) => !masters.has(k.name)).length;
  const childPresent = visible.reduce((n, k) => n + k.children.filter((c) => c.xpub.trim()).length, 0);
  const childNeeded = reuseKeys
    ? childPresent
    : visible.reduce((n, k) => n + (aliases.get(k.name) ?? []).filter((a) => a.account != null).length, 0);

  function closeDetails() {
    setDetailsId(null);
    setExpandedId(null);
  }

  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col overflow-hidden bg-bg" : "shrink-0 border-b border-border bg-bg"}>
      <div className="flex flex-wrap items-end justify-end gap-3 px-4 pt-3 pb-2">
        <NestedKeyStack present={childPresent} total={Math.max(childNeeded, childPresent)} />
        {unusedCount ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const n = removeUnusedKeys();
              if (n) toast.success(t("keys.pruned", { n: String(n) }));
            }}
          >
            {t("keys.prune")}
          </Button>
        ) : null}
      </div>
      <div className={fill ? "min-h-0 flex-1 overflow-auto px-4 pb-3" : "max-h-40 overflow-auto px-4 pb-3"}>
        {visible.length === 0 ? (
          <p className="py-2 text-xs text-fg-muted">{t("keys.empty")}</p>
        ) : (
          <div className="flex w-full flex-col gap-1.5">
            {visible.map((k) => (
              <KeyTile
                key={k.id}
                entry={k}
                expanded={expandedId === k.id}
                aliases={aliases.get(k.name) ?? []}
                reuseOff={!reuseKeys}
                needsAction={Boolean(keyNeedsAction(k, aliases.get(k.name) ?? [], reuseKeys))}
                used={masters.has(k.name)}
                childPresent={k.children.filter((c) => c.xpub.trim()).length}
                childTotal={
                  reuseKeys
                    ? k.children.length
                    : Math.max(
                        k.children.length,
                        (aliases.get(k.name) ?? []).filter((a) => a.account != null).length,
                      )
                }
                onDelete={() => {
                  const kids = k.children.filter((c) => c.xpub.trim()).length;
                  if (kids && !window.confirm(t("keys.deleteChildren", { n: String(kids) }))) return;
                  useStudio.getState().removeKey(k.id);
                  if (expandedId === k.id || detailsId === k.id) {
                    setExpandedId(null);
                    setDetailsId(null);
                  }
                }}
                onToggle={() => {
                  if (expandedId === k.id) {
                    setDetailsId(k.id);
                    return;
                  }
                  setExpandedId(k.id);
                }}
              />
            ))}
          </div>
        )}
      </div>
      <KeyImportDialog entry={details} open={Boolean(details)} onOpenChange={(open) => !open && closeDetails()} />
    </div>
  );
}

function KeyTile({
  entry,
  expanded,
  aliases,
  reuseOff,
  needsAction,
  used,
  childPresent,
  childTotal,
  onToggle,
  onDelete,
}: {
  entry: KeyEntry;
  expanded: boolean;
  aliases: { alias: string; delay: number; account?: number; branch?: string }[];
  reuseOff: boolean;
  needsAction: boolean;
  used: boolean;
  childPresent: number;
  childTotal: number;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const filled = keyIsFilled(entry);
  const role = keyRoleLabel(entry.name);
  const name = entry.note.trim();
  const fp = entry.fingerprint.trim().toLowerCase();
  const tileClass = needsAction
    ? "border-danger/80 bg-danger/10 text-fg hover:bg-danger/15"
    : filled
      ? "border-border-strong bg-surface text-fg hover:bg-elevated"
      : "border-dashed border-border bg-transparent text-fg-muted hover:bg-muted hover:text-fg";

  if (!expanded) {
    return (
      <div className={`flex min-h-10 w-full items-stretch gap-0.5 rounded-md border ${tileClass}`}>
        <button
          type="button"
          data-key-tile={entry.name}
          data-need-action={needsAction ? "true" : undefined}
          aria-expanded={false}
          aria-label={needsAction ? t("keys.needAction", { name: entry.name }) : undefined}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs"
        >
          <span className="min-w-0 flex-1 truncate">{name || t("keys.unnamed")}</span>
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-2xs ${used ? "bg-muted text-fg-subtle" : "text-fg-muted"}`}>
            {used ? t("keys.inUse") : t("keys.idle")}
          </span>
          <span className="shrink-0 font-mono text-2xs text-fg-muted">{fp || "—"}</span>
          <span className={`shrink-0 font-mono text-2xs ${needsAction ? "text-danger" : "text-fg-subtle"}`}>{role}</span>
          {childTotal > 0 ? <NestedKeyStack present={childPresent} total={childTotal} compact /> : null}
        </button>
        {fp ? <CopyButton value={fp} className="self-center" /> : null}
        <button
          type="button"
          aria-label={t("keys.delete")}
          title={t("keys.delete")}
          onClick={onDelete}
          className="shrink-0 px-2 text-fg-muted hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      data-key-tile={entry.name}
      data-need-action={needsAction ? "true" : undefined}
      className={`relative w-full rounded-xl border p-3 text-left transition-colors duration-150 ${tileClass}`}
    >
      <button
        type="button"
        aria-expanded={true}
        aria-label={needsAction ? t("keys.needAction", { name: entry.name }) : undefined}
        onClick={onToggle}
        className="flex w-full items-baseline justify-between gap-2 text-left"
      >
        <p className="min-w-0 truncate text-sm text-fg">{name || t("keys.unnamed")}</p>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-2xs ${used ? "bg-muted text-fg-subtle" : "text-fg-muted"}`}>
          {used ? t("keys.inUse") : t("keys.idle")}
        </span>
        <span className={`shrink-0 font-mono text-2xs ${needsAction ? "text-danger" : "text-fg-subtle"}`}>{role}</span>
        {childTotal > 0 ? <NestedKeyStack present={childPresent} total={childTotal} compact /> : null}
      </button>
      <button
        type="button"
        aria-label={t("keys.delete")}
        title={t("keys.delete")}
        onClick={onDelete}
        className="absolute top-2.5 right-2.5 text-fg-muted hover:text-danger"
      >
        <Trash2 className="size-3.5" />
      </button>
      <p className="mt-0.5 inline-flex items-center gap-0.5 font-mono text-2xs text-fg-muted">
        {fp || "—"}
        {fp ? <CopyButton value={fp} /> : null}
      </p>
      <ul className="mt-2 space-y-1.5">
        <li className="rounded-md border border-border/80 bg-elevated/40 px-2 py-1.5">
          <p className="font-mono text-2xs text-fg-subtle">{role}</p>
          <XpubLine xpub={entry.xpub} />
        </li>
        {entry.children.map((c) => (
          <li key={c.id} className="rounded-md border border-border/80 bg-elevated/40 px-2 py-1.5">
            <p className="font-mono text-2xs text-fg-subtle">{childRoleLabel(entry.name, c.path)}</p>
            <XpubLine xpub={c.xpub} />
          </li>
        ))}
        {reuseOff
          ? aliases
              .filter((a) => a.account != null && !childForAccount(entry, a.account)?.xpub.trim())
              .map((a) => (
                <li key={a.alias} className="rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-danger">{t("keys.missing")}</span>
                    <span className="font-mono text-2xs text-danger">{childRoleLabel(entry.name, accountPathFrom(entry.derivation, a.account!))}</span>
                  </div>
                </li>
              ))
          : aliases
              .filter((a) => a.branch)
              .map((a) => (
                <li key={a.alias} className="rounded-md border border-border/80 bg-elevated/40 px-2 py-1.5">
                  <p className="font-mono text-2xs text-fg-subtle">
                    {a.alias} · /{a.branch}
                  </p>
                </li>
              ))}
      </ul>
      {filled ? (
        <button type="button" onClick={onToggle} className="mt-2 text-2xs text-fg-subtle">
          {t("keys.tapDetails")}
        </button>
      ) : null}
      {reuseOff && aliases.some((a) => a.account != null) ? (
        <p className="mt-2 text-2xs text-fg-muted">
          {t("keys.nextAccount", { path: nextUnusedAccount(entry).path })}
        </p>
      ) : null}
    </div>
  );
}

export function KeyReuseControls() {
  const { t } = useT();
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const setReuseKeys = useStudio((s) => s.setReuseKeys);
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("keys.section")}</span>
      <p className="whitespace-pre-line text-2xs text-pretty text-fg-muted">{t("keys.reuseHint")}</p>
      <div role="group" aria-label={t("keys.reuse")} className="flex flex-wrap gap-1.5">
        <button
          type="button"
          aria-pressed={!reuseKeys}
          onClick={() => setReuseKeys(false)}
          className={
            !reuseKeys
              ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
              : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
          }
        >
          {t("keys.reuseOffShort")}
        </button>
        <button
          type="button"
          aria-pressed={reuseKeys}
          onClick={() => setReuseKeys(true)}
          className={
            reuseKeys
              ? "h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
              : "h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
          }
        >
          {t("keys.reuseOnShort")}
        </button>
      </div>
    </div>
  );
}

function NestedKeyStack({
  present,
  total,
  compact = false,
}: {
  present: number;
  total: number;
  compact?: boolean;
}) {
  const { t } = useT();
  const n = Math.min(Math.max(total, 0), 5);
  const size = compact ? "size-4" : "size-5";
  const step = compact ? 8 : 10;
  const chip = compact ? 16 : 20;
  const width = n <= 0 ? chip : (n - 1) * step + chip;
  return (
    <span
      className="relative inline-flex h-5 shrink-0 items-center"
      style={{ width }}
      title={t("keys.childMark", { have: present, need: Math.max(total, present) })}
      aria-label={t("keys.childMark", { have: present, need: Math.max(total, present) })}
    >
      {n <= 0 ? (
        <span className="relative flex size-5 items-center justify-center text-fg-subtle">
          <KeyRound className="size-3.5 opacity-40" />
        </span>
      ) : (
        Array.from({ length: n }, (_, i) => {
          const ok = i < present;
          return (
            <span
              key={i}
              className={`absolute flex items-center justify-center rounded-md border ${size} ${
                ok ? "border-border-strong bg-elevated text-fg" : "border-danger/70 bg-danger/10 text-danger"
              }`}
              style={{ left: i * step, zIndex: i + 1 }}
            >
              <KeyRound className="absolute size-3 opacity-35" aria-hidden />
              <span className="relative font-mono text-[9px] leading-none">{i + 1}</span>
            </span>
          );
        })
      )}
    </span>
  );
}

function XpubLine({ xpub }: { xpub: string }) {
  const [open, setOpen] = useState(false);
  const { t } = useT();
  if (!xpub.trim()) return <p className="font-mono text-2xs text-fg-muted">—</p>;
  return (
    <div className="flex items-start gap-0.5">
      <button
        type="button"
        title={t("keys.xpubTap")}
        onClick={() => setOpen((v) => !v)}
        className="min-w-0 flex-1 break-all text-left font-mono text-2xs text-fg-muted hover:text-fg"
      >
        {open ? xpub : shortXpub(xpub)}
      </button>
      <CopyButton value={xpub} />
    </div>
  );
}

function KeySlotTree({
  entry,
  needs,
  stages,
  reuse,
}: {
  entry: KeyEntry;
  needs: { alias: string; delay: number; account?: number; branch?: string }[];
  stages: Stage[];
  reuse: boolean;
}) {
  const { t, locale } = useT();
  const rows: {
    key: string;
    role: string;
    path: string;
    xpub: string;
    slots: StageSignerSlot[];
    missing?: boolean;
  }[] = [
    {
      key: "master",
      role: keyRoleLabel(entry.name),
      path: entry.derivation || "48'/0'/0'/2'",
      xpub: entry.xpub,
      slots: slotsForAccount(stages, entry.name, 0, reuse),
    },
    ...entry.children.map((c) => {
      const acc = parseAccountIndex(c.path);
      return {
        key: c.id,
        role: childRoleLabel(entry.name, c.path),
        path: c.path.replace(/^m\//, ""),
        xpub: c.xpub,
        slots: acc != null ? slotsForAccount(stages, entry.name, acc, reuse) : [],
      };
    }),
    ...(!reuse
      ? needs
          .filter((n) => n.account != null && !childForAccount(entry, n.account)?.xpub.trim())
          .map((n) => ({
            key: n.alias,
            role: childRoleLabel(entry.name, accountPathFrom(entry.derivation, n.account!)),
            path: accountPathFrom(entry.derivation, n.account!),
            xpub: "",
            slots: slotsForAccount(stages, entry.name, n.account!, reuse),
            missing: true,
          }))
      : needs
          .filter((n) => n.branch)
          .map((n) => ({
            key: n.alias,
            role: n.alias,
            path: n.branch!,
            xpub: entry.xpub,
            slots: slotsForAccount(stages, entry.name, 0, true).filter((s) => s.delay === n.delay),
          }))),
  ];

  function slotLine(slot: StageSignerSlot, selfRole: string): string {
    const others = slot.signers.filter((s) => s.role !== selfRole).map((s) => s.role);
    const when = slot.delay > 0 ? blocksWhen(slot.delay, locale) : t("read.now");
    return [t("stages.n", { n: slot.index }), ...others, slot.quorum, when].join(" · ");
  }

  return (
    <div className="w-full font-mono">
      <p className="text-xs text-fg">m</p>
      <ul className="border-l border-border pl-3">
        {rows.map((r) => (
          <li key={r.key} className={`py-1.5 ${r.missing ? "text-danger" : "text-fg"}`}>
            <p className="text-xs">
              {r.role}
              <span className={`ml-2 text-2xs ${r.missing ? "text-danger" : "text-fg-muted"}`}>{r.path}</span>
            </p>
            {r.slots.length ? (
              <ul className={`mt-0.5 space-y-0.5 text-2xs ${r.missing ? "text-danger" : "text-fg-muted"}`}>
                {r.slots.map((slot) => (
                  <li key={slot.index}>{slotLine(slot, r.role)}</li>
                ))}
              </ul>
            ) : (
              <p className={`text-2xs ${r.missing ? "text-danger" : "text-fg-muted"}`}>
                {r.missing ? t("keys.missing") : "—"}
              </p>
            )}
            {r.missing ? null : <XpubLine xpub={r.xpub} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function KeyImportDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: KeyEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const importKeyText = useStudio((s) => s.importKeyText);
  const importChildText = useStudio((s) => s.importChildText);
  const updateKey = useStudio((s) => s.updateKey);
  const removeChild = useStudio((s) => s.removeChild);
  const network = useStudio((s) => s.network);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const stages = useStudio((s) => s.stages);
  const [draft, setDraft] = useState("");
  const [childDraft, setChildDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const filled = entry ? keyIsFilled(entry) : false;
  const hwTarget = useRef<"master" | "child">("master");
  const fetchHw = useHwFillKey(entry?.id ?? "", (origin) => {
    if (hwTarget.current === "child") setChildDraft(origin);
    else setDraft(origin);
    setError(null);
  });

  const needs = entry ? (reuseAliasHints(stages, reuseKeys).get(entry.name) ?? []) : [];
  const next = entry ? nextUnusedAccount(entry, network) : { account: 1, path: "48'/0'/1'/2'" };
  const nextNeed = needs.find((n) => n.account != null && !childForAccount(entry!, n.account));

  const onRead = useCallback(
    (text: string) => {
      if (!entry) return;
      const err = importKeyText(entry.id, text);
      if (err) {
        setError(err);
        return;
      }
      setDraft("");
      setError(null);
      toast.success(t("keys.taken", { name: entry.name }));
    },
    [entry, importKeyText, t],
  );

  const onChild = useCallback(
    (text: string) => {
      if (!entry) return;
      const err = importChildText(entry.id, text, {
        fallbackPath: next.path,
        alias: nextNeed?.alias,
      });
      if (err) {
        setError(err);
        return;
      }
      setChildDraft("");
      setError(null);
      toast.success(t("keys.childTaken"));
    },
    [entry, importChildText, next.path, nextNeed?.alias, t],
  );

  function openDetailsFrom(nextOpen: boolean) {
    if (!nextOpen) {
      setDraft("");
      setChildDraft("");
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  if (!entry) return null;
  const preview = draft.trim() ? applyKeyMaterial(entry, draft) : null;
  const childPreview = childDraft.trim()
    ? parseChildKey(entry, childDraft, { fallbackPath: next.path, alias: nextNeed?.alias })
    : null;

  return (
    <Dialog open={open} onOpenChange={openDetailsFrom}>
      <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] w-[min(720px,calc(100vw-1rem))] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-1">
            {entry.note.trim() || t("keys.unnamed")}
            <span className="ml-2 inline-flex items-center font-mono text-sm font-normal text-fg-muted">
              {entry.fingerprint || "—"}
              {entry.fingerprint ? <CopyButton value={entry.fingerprint} /> : null}
              <span className="ml-1">· {keyRoleLabel(entry.name)}</span>
            </span>
          </DialogTitle>
          <DialogDescription>{t("keys.dialogBlurb")}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="master" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TabsList className="w-full shrink-0">
            <TabsTrigger value="master" className="flex-1">
              {t("keys.master")}
            </TabsTrigger>
            <TabsTrigger value="children" className="flex-1">
              {t("keys.children")}
            </TabsTrigger>
            <TabsTrigger value="details" className="flex-1">
              {t("keys.details")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="master" className="min-h-0 flex-1 space-y-3 overflow-auto">
            <Field label={t("keys.name")}>
              <Input
                value={entry.note}
                placeholder="NANO-S, Coldcard, …"
                onChange={(e) => updateKey(entry.id, { note: e.target.value })}
              />
            </Field>
            <p className="inline-flex flex-wrap items-center gap-0.5 font-mono text-2xs text-fg-muted">
              {t("keys.role")}: {keyRoleLabel(entry.name)}
              {entry.fingerprint ? (
                <>
                  <span> · {entry.fingerprint}</span>
                  <CopyButton value={entry.fingerprint} />
                </>
              ) : null}
            </p>
            <XpubLine xpub={entry.xpub} />
            {reuseKeys && needs.some((n) => n.branch) ? <ReusePlan needs={needs} /> : null}
            {!reuseKeys && needs.length ? <AccountPlan entry={entry} needs={needs} /> : null}
            <ImportPane
              draft={draft}
              setDraft={setDraft}
              placeholder={`[deadbeef/48'/0'/0'/2']xpub…`}
              onApply={() => onRead(draft)}
              onQr={setDraft}
              error={error}
              applyLabel={filled && draft.trim() ? t("keys.applyReplace") : t("keys.apply")}
              canApply={Boolean(draft.trim()) && preview?.ok !== false}
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    hwTarget.current = "master";
                    void fetchHw("ledger");
                  }}
                >
                  {t("hw.fromLedger")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    hwTarget.current = "master";
                    void fetchHw("bitbox");
                  }}
                >
                  {t("hw.fromBitbox")}
                </Button>
                {filled ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      updateKey(entry.id, { xpub: "", fingerprint: "", children: [] });
                      setError(null);
                      toast.success(t("keys.cleared"));
                    }}
                  >
                    {t("keys.clear")}
                  </Button>
                ) : null}
              </div>
              {preview?.ok ? (
                <p className="inline-flex flex-wrap items-center gap-1 font-mono text-2xs text-fg-muted">
                  {preview.key.fingerprint ? (
                    <Copyable value={preview.key.fingerprint} textClassName="text-2xs text-fg-muted" />
                  ) : (
                    "—"
                  )}
                  <span>· {preview.key.derivation || "—"} · {t("keys.draftHint")}</span>
                </p>
              ) : null}
            </ImportPane>
          </TabsContent>
          <TabsContent value="children" className="min-h-0 flex-1 space-y-3 overflow-auto">
            {filled || entry.fingerprint ? (
              <>
                {reuseKeys ? <ReusePlan needs={needs} /> : null}
                {!reuseKeys ? <AccountPlan entry={entry} needs={needs} onPick={(path) => setChildDraft(`[${entry.fingerprint}/${path}]`)} /> : null}
                <p className="font-mono text-2xs text-fg-muted">{t("keys.nextAccount", { path: next.path })}</p>
                <ImportPane
                  draft={childDraft}
                  setDraft={setChildDraft}
                  placeholder={`[${entry.fingerprint || "fp"}/${next.path}]xpub   oder   0/0`}
                  onApply={() => onChild(childDraft)}
                  onQr={setChildDraft}
                  error={error}
                  applyLabel={t("keys.childApply")}
                  canApply={Boolean(childDraft.trim()) && childPreview?.ok !== false}
                >
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        hwTarget.current = "child";
                        void fetchHw("ledger", `m/${next.path}`);
                      }}
                    >
                      {t("hw.fromLedger")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        hwTarget.current = "child";
                        void fetchHw("bitbox", `m/${next.path}`);
                      }}
                    >
                      {t("hw.fromBitbox")}
                    </Button>
                  </div>
                  {childPreview?.ok ? (
                    <p className="font-mono text-2xs text-fg-muted">
                      {childPreview.child.path}
                      {childPreview.child.note ? ` · ${childPreview.child.note}` : ""} · {t("keys.draftHint")}
                    </p>
                  ) : null}
                </ImportPane>
                {entry.children.length ? (
                  <ul className="w-full space-y-1.5">
                    {entry.children.map((c) => (
                      <li
                        key={c.id}
                        className="flex w-full items-start gap-2 rounded-md border border-border bg-elevated px-2.5 py-2"
                      >
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="block font-mono text-xs text-fg">
                            {childRoleLabel(entry.name, c.path)}
                          </span>
                          <span className="block font-mono text-2xs text-fg-muted">{c.path}</span>
                          <XpubLine xpub={c.xpub} />
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg"
                          onClick={() => removeChild(entry.id, c.id)}
                          aria-label={t("keys.childRemove")}
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-fg-muted">{t("keys.childHelp")}</p>
                )}
              </>
            ) : (
              <p className="text-sm text-fg-muted">{t("keys.childNeedParent")}</p>
            )}
          </TabsContent>
          <TabsContent value="details" className="min-h-0 flex-1 space-y-3 overflow-auto">
            <p className="text-2xs text-fg-muted">{t("keys.detailsTogether")}</p>
            <p className="text-2xs text-fg-muted">{t("keys.xpubTap")}</p>
            <KeySlotTree entry={entry} needs={needs} stages={stages} reuse={reuseKeys} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ReusePlan({ needs }: { needs: { alias: string; delay: number; branch?: string }[] }) {
  const { t } = useT();
  const rows = needs.filter((n) => n.branch);
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-elevated px-3 py-2">
      <p className="text-xs text-fg">{t("keys.reuseOnNeed")}</p>
      <ul className="space-y-1">
        {rows.map((n) => (
          <li key={n.alias} className="font-mono text-2xs text-fg">
            {n.alias} · /{n.branch}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountPlan({
  entry,
  needs,
  onPick,
}: {
  entry: KeyEntry;
  needs: { alias: string; delay: number; account?: number; branch?: string }[];
  onPick?: (path: string) => void;
}) {
  const { t } = useT();
  const extras = needs.filter((n) => n.account != null);
  if (!extras.length) return null;
  const next = nextUnusedAccount(entry);
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-elevated px-3 py-2">
      <p className="text-xs text-fg">{t("keys.reuseNeed")}</p>
      <p className="font-mono text-2xs text-fg-muted">
        {t("keys.master")} · {entry.derivation || "48'/0'/0'/2'"}
      </p>
      <ul className="space-y-1">
        {extras.map((n) => {
          const path = n.account != null ? accountPathFrom(entry.derivation, n.account) : "";
          const has = n.account != null && Boolean(childForAccount(entry, n.account)?.xpub);
          return (
            <li key={n.alias}>
              <button
                type="button"
                disabled={!onPick}
                onClick={() => onPick?.(path)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-0.5 text-left font-mono text-2xs"
              >
                <span className="text-fg">
                  {childRoleLabel(entry.name, path)} · {path}
                </span>
                <span className={has ? "text-ok" : "text-danger"}>{has ? t("keys.present") : t("keys.missing")}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="font-mono text-2xs text-fg">{t("keys.nextAccount", { path: next.path })}</p>
    </div>
  );
}

function ImportPane({
  draft,
  setDraft,
  placeholder,
  onApply,
  onQr,
  error,
  applyLabel,
  canApply,
  children,
}: {
  draft: string;
  setDraft: (v: string) => void;
  placeholder: string;
  onApply: () => void;
  onQr: (text: string) => void;
  error: string | null;
  applyLabel?: string;
  canApply?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useT();
  return (
    <>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        className="min-h-20"
      />
      <div className="flex flex-wrap items-center gap-2">
        <FilePick onRead={setDraft} />
      </div>
      <QrScanner compact onRead={onQr} />
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      <div className="flex justify-end">
        <Button type="button" onClick={onApply} disabled={canApply === false || !draft.trim()}>
          <Upload />
          {applyLabel ?? t("keys.apply")}
        </Button>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="w-full space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
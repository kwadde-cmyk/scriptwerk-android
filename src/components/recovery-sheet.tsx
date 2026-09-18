import { useEffect, useMemo, useState } from "react";
import { compiledForStudio, policyIsFrozen } from "@/lib/miniscript/policy-mode";
import {
  displayKeyToken,
  formatFingerprint,
  keyOriginExpr,
  keyRoleLabel,
  childRoleLabel,
  parseAccountIndex,
  shortXpub,
  type KeyChild,
  type KeyEntry,
} from "@/lib/miniscript/keys";
import { describeStageSlots } from "@/lib/miniscript/stages";
import { peekChecksum } from "@/lib/policy-library";
import { descriptorForBranch } from "@/lib/hw/address-check";
import { deriveAddressRange } from "@/lib/bitcoind/rpc";
import { useStudio } from "@/store/studio";
import { useBitcoind } from "@/store/bitcoind";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SheetQr } from "@/components/qr-io";
import { useT } from "@/lib/use-t";
import { ScrollText } from "lucide-react";

const addrCache = { list: [] as string[] };
const printGate = { on: false, listeners: new Set<() => void>() };

function armPrintRoot() {
  printGate.on = true;
  for (const fn of printGate.listeners) fn();
}

export function RecoverySheetButton() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" className="size-9" aria-label={t("recovery.title")}>
          <ScrollText />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[min(92dvh,56rem)] w-[min(52rem,calc(100vw-1rem))] flex-col overflow-hidden print:hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("recovery.title")}</DialogTitle>
          <DialogDescription>{t("recovery.blurb")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-white p-4 text-neutral-900">
          <RecoveryDocument />
        </div>
        <div className="flex shrink-0 justify-end pt-2">
          <Button
            onClick={() => {
              armPrintRoot();
              setOpen(false);
              window.setTimeout(() => window.print(), 240);
            }}
          >
            {t("recovery.print")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RecoveryPrintRoot() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(printGate.on);
    printGate.listeners.add(sync);
    const after = () => {
      printGate.on = false;
      setOn(false);
    };
    window.addEventListener("afterprint", after);
    return () => {
      printGate.listeners.delete(sync);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  return (
    <div className="print-root hidden bg-white p-0 text-black print:block">
      {on ? <RecoveryDocument print /> : null}
    </div>
  );
}

function RecoveryDocument({ print = false }: { print?: boolean }) {
  const { t, locale } = useT();
  const policyName = useStudio((s) => s.policyName);
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const frozen = useStudio((s) => policyIsFrozen(s.policyMode));
  const nodeStatus = useBitcoind((s) => s.status);
  const lastCheck = useBitcoind((s) => s.lastCheck);
  const compiled = useStudio(compiledForStudio);
  const descriptor = compiled?.ok ? compiled.descriptor : "";
  const checksum = peekChecksum(descriptor);
  const slots = useMemo(() => describeStageSlots(stages, reuseKeys), [stages, reuseKeys]);
  const [when, setWhen] = useState("");
  const [addrs, setAddrs] = useState<string[]>(() => addrCache.list);
  const cls = print
    ? "recovery-sheet mx-auto max-w-[190mm] p-2 text-[11pt] leading-snug text-black"
    : "space-y-5 text-sm text-neutral-900";

  useEffect(() => {
    setWhen(new Date().toLocaleString(locale === "en" ? "en-GB" : "de-DE"));
  }, [locale]);

  useEffect(() => {
    const apply = (list: string[]) => {
      addrCache.list = list;
      setAddrs(list);
    };
    if (print) {
      const sync = () => setAddrs(addrCache.list.length ? addrCache.list : (lastCheck?.addresses ?? []));
      sync();
      window.addEventListener("beforeprint", sync);
      return () => window.removeEventListener("beforeprint", sync);
    }
    if (!descriptor || nodeStatus !== "ready") {
      const fallback = lastCheck?.addresses ?? [];
      if (fallback.length) apply(fallback);
      return;
    }
    let cancelled = false;
    const cfg = useBitcoind.getState();
    const recv = descriptorForBranch(descriptor, 0);
    void deriveAddressRange({ url: cfg.url, username: cfg.username, password: cfg.password }, recv, 0, 9)
      .then((list) => {
        if (!cancelled) apply(list);
      })
      .catch(() => {
        if (!cancelled) apply(lastCheck?.addresses ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [descriptor, nodeStatus, lastCheck, print]);

  return (
    <div className={cls}>
      <header className="flex items-start justify-between gap-4 border-b border-neutral-400 pb-3">
        <div>
          <p className="text-[10px] tracking-[0.28em] text-neutral-600 uppercase">Scriptwerk</p>
          <h2 className="font-display text-xl font-semibold">{t("recovery.heading")}</h2>
          <p className="text-xs text-neutral-700">
            {policyName || "Scriptwerk"} · {when}
          </p>
        </div>
        {checksum ? (
          <div className="flex flex-col items-center gap-1">
            <SheetQr value={`#${checksum}`} size={print ? 88 : 72} label={t("recovery.checksum")} />
            <p className="font-mono text-[10px]">#{checksum}</p>
          </div>
        ) : null}
      </header>

      {!frozen && slots.length ? (
      <section className="mt-4">
        <h3 className="text-[10px] font-semibold tracking-wide uppercase">{t("recovery.stages")}</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          {slots.map((s) => {
            const stage = stages[s.index - 1];
            const must = (stage?.required ?? []).map((tok) => displayKeyToken(tok, keys)).join(", ");
            const delay =
              s.delay <= 0
                ? t("recovery.now")
                : `${s.delay} ${t("recovery.blocks")}${s.delay >= 144 ? ` ≈ ${Math.round(s.delay / 144)} ${t("recovery.days")}` : ""}`;
            return (
              <li key={s.index}>
                <span className="font-medium">{s.quorum}</span>
                {" · "}
                {delay}
                {" · "}
                {s.signers.map((x) => displayKeyToken(x.token, keys)).join(", ")}
                {must ? ` · ${t("recovery.must")}: ${must}` : ""}
              </li>
            );
          })}
        </ol>
      </section>
      ) : null}

      <section className="mt-4">
        <h3 className="text-[10px] font-semibold tracking-wide uppercase">{t("recovery.keys")}</h3>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {keys.flatMap((k) => {
            const rows: { id: string; title: string; sub: string; payload: string }[] = [];
            if (k.xpub.trim() || k.fingerprint) {
              rows.push({
                id: k.id,
                title: k.note.trim() ? `${k.note.trim()} (${k.name})` : keyRoleLabel(k.name),
                sub: `${formatFingerprint(k.fingerprint) || "—"} · ${keyRoleLabel(k.name)} · ${k.derivation || "—"}`,
                payload: keyOriginExpr(k),
              });
            }
            for (const c of k.children ?? []) {
              if (!c.xpub.trim()) continue;
              rows.push(childRow(k, c));
            }
            return rows.map((row) => (
              <div key={row.id} className="flex gap-3 break-inside-avoid border border-neutral-300 p-2">
                <SheetQr value={row.payload} size={print ? 92 : 80} label={row.title} />
                <div className="min-w-0">
                  <p className="font-medium">{row.title}</p>
                  <p className="font-mono text-[10px] break-all text-neutral-700">{row.sub}</p>
                  <p className="mt-1 font-mono text-[9px] break-all text-neutral-500">{shortXpub(row.payload, 20, 10)}</p>
                </div>
              </div>
            ));
          })}
        </div>
      </section>

      <section className="mt-4">
        <h3 className="text-[10px] font-semibold tracking-wide uppercase">{t("recovery.addresses")}</h3>
        <p className="text-xs text-neutral-600">{t("recovery.addrHint")}</p>
        {addrs.length ? (
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {addrs.map((a, i) => (
              <div key={`${a}-${i}`} className="flex gap-3 break-inside-avoid border border-neutral-300 p-2">
                <SheetQr value={a} size={print ? 88 : 76} label={`${t("recovery.receive")} ${i}`} />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold tracking-wide uppercase">
                    {t("recovery.receive")} {i}
                  </p>
                  <p className="font-mono text-[10px] break-all">{a}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-neutral-600">{t("recovery.addrNeedNode")}</p>
        )}
      </section>

      <section className="mt-4 break-inside-avoid">
        <h3 className="text-[10px] font-semibold tracking-wide uppercase">{t("recovery.watchonly")}</h3>
        <p className="text-xs text-neutral-600">{t("recovery.watchonlyHint")}</p>
        <div className="mt-2 flex flex-col items-start gap-3 sm:flex-row">
          {descriptor ? <SheetQr value={descriptor} size={print ? 220 : 184} label={t("recovery.watchonly")} /> : null}
          <p className="min-w-0 break-all font-mono text-[9px] leading-relaxed">{descriptor || "—"}</p>
        </div>
      </section>

      <p className="mt-4 text-[10px] text-neutral-600">{t("recovery.disclaimer")}</p>
    </div>
  );
}

function childRow(k: KeyEntry, c: KeyChild) {
  const role = childRoleLabel(k.name, c.path);
  const note = c.note.trim() || k.note.trim();
  const acc = parseAccountIndex(c.path);
  const token = acc != null && acc > 0 ? `${k.name}${acc}` : k.name;
  return {
    id: c.id,
    title: note ? `${note} (${token})` : role,
    sub: `${formatFingerprint(c.fingerprint || k.fingerprint) || "—"} · ${role} · ${c.path}`,
    payload: keyOriginExpr({
      fingerprint: c.fingerprint || k.fingerprint,
      derivation: c.path,
      xpub: c.xpub,
    }),
  };
}

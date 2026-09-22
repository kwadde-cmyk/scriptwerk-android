import { useEffect, useMemo, useState } from "react";
import { keyHeadline } from "@/lib/miniscript/keys";
import { coinHeightFromConfirms, evaluateSpendPaths } from "@/lib/miniscript/spend-check";
import { policyIsFrozen } from "@/lib/miniscript/policy-mode";
import { formatAmount } from "@/lib/hw/address-check";
import { fetchElectrumTip } from "@/lib/bitcoind/rpc";
import { useBitcoind } from "@/store/bitcoind";
import { useStudio } from "@/store/studio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/use-t";
import { numberLocale } from "@/lib/i18n";

export function SpendCheckCard() {
  const { t, locale } = useT();
  const nloc = numberLocale(locale);
  const unit = useStudio((s) => s.amountUnit);
  const amt = (n: number) => formatAmount(n, unit, nloc).label;
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const frozen = useStudio((s) => policyIsFrozen(s.policyMode));
  const selectStage = useStudio((s) => s.selectStage);
  const selectedStageId = useStudio((s) => s.selectedStageId);
  const probe = useBitcoind((s) => s.probe);
  const status = useBitcoind((s) => s.status);
  const lastUtxo = useBitcoind((s) => s.lastUtxo);
  const [present, setPresent] = useState<string[]>([]);
  const [tip, setTip] = useState(0);
  const [tipSource, setTipSource] = useState<"core" | "electrum" | "manual">("manual");
  const [confirms, setConfirms] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tipError, setTipError] = useState<string | null>(null);

  const masters = useMemo(
    () => keys.filter((k) => k.name.trim()).sort((a, b) => a.name.localeCompare(b.name)),
    [keys],
  );
  const coins = useMemo(() => lastUtxo?.coins ?? [], [lastUtxo]);
  const coinHeight = coins.length ? 0 : coinHeightFromConfirms(tip, confirms);
  const report = useMemo(
    () =>
      evaluateSpendPaths({
        stages,
        reuse: reuseKeys,
        present,
        keys,
        tip,
        coinHeight,
        coins,
      }),
    [stages, reuseKeys, present, keys, tip, coinHeight, coins],
  );

  useEffect(() => {
    if (status === "ready" && probe && probe.blocks > 0 && probe.chain !== "demo") {
      setTip(probe.blocks);
      setTipSource("core");
      setTipError(null);
      setBusy(false);
      return;
    }
    if (lastUtxo && lastUtxo.height > 0) {
      setTip((cur) => (cur > 0 ? cur : lastUtxo.height));
      setTipSource((cur) => (cur === "manual" ? "electrum" : cur));
    }
  }, [status, probe, lastUtxo]);

  async function loadElectrumTip() {
    setBusy(true);
    setTipError(null);
    try {
      const height = await fetchElectrumTip(useBitcoind.getState().electrum);
      setTip(height);
      setTipSource("electrum");
    } catch (e) {
      setTipSource("manual");
      setTipError(e instanceof Error ? e.message : "spend.err.tip");
    } finally {
      setBusy(false);
    }
  }

  function toggle(name: string) {
    setPresent((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  }

  return (
    <section className="space-y-3">
      <h2 className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">{t("spend.title")}</h2>
      <p className="text-2xs text-pretty text-fg-muted">{frozen ? t("spend.frozen") : t("spend.blurb")}</p>

      <div>
        <Label>{t("spend.have")}</Label>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {masters.map((k) => {
            const on = present.includes(k.name);
            return (
              <button
                key={k.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(k.name)}
                className={
                  on
                    ? "min-h-9 rounded-full bg-primary px-3 text-xs text-primary-foreground"
                    : "min-h-9 rounded-full border border-border px-3 text-xs text-fg-muted hover:bg-muted hover:text-fg"
                }
              >
                {keyHeadline(k)}
                <span className="ml-1.5 font-mono text-2xs opacity-70">{k.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`grid gap-2 ${coins.length ? "grid-cols-1" : "grid-cols-2"}`}>
        <div>
          <Label htmlFor="spend-tip">{t("spend.tip")}</Label>
          <Input
            id="spend-tip"
            type="number"
            min={0}
            value={tip || ""}
            onChange={(e) => {
              setTip(Number(e.target.value) || 0);
              setTipSource("manual");
            }}
            className="mt-1.5 font-mono text-xs"
          />
          <p className="mt-1 text-2xs text-fg-subtle">
            {busy ? t("spend.tipLoading") : t("spend.tipSrc." + tipSource)}
          </p>
          {tipSource !== "core" ? (
            <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 px-2 text-2xs" onClick={() => void loadElectrumTip()} disabled={busy}>
              {t("spend.tipElectrum")}
            </Button>
          ) : null}
        </div>
        {coins.length ? (
          <p className="text-2xs text-fg-muted">
            {t("spend.utxoCount", { n: coins.length, btc: amt(report.total) })}
            {report.confirmations
              ? ` · ${t("spend.oldest", { n: report.confirmations.toLocaleString(nloc) })}`
              : ""}
          </p>
        ) : (
          <div>
            <Label htmlFor="spend-age">{t("spend.age")}</Label>
            <Input
              id="spend-age"
              type="number"
              min={0}
              value={confirms}
              onChange={(e) => setConfirms(Math.max(0, Number(e.target.value) || 0))}
              className="mt-1.5 font-mono text-xs"
            />
            <p className="mt-1 text-2xs text-fg-subtle">{t("spend.ageHint")}</p>
          </div>
        )}
      </div>
      {tipError && tipSource === "manual" && !tip ? (
        <p className="text-2xs text-fg-muted">{t("spend.tipManual")}</p>
      ) : null}

      {!present.length ? (
        <p className="text-xs text-fg-muted">{t("spend.pick")}</p>
      ) : report.anyNow ? (
        <p className="text-xs text-ok">{t("spend.someNow")}</p>
      ) : report.anyLater ? (
        <p className="text-xs text-warn">{t("spend.keysLater")}</p>
      ) : (
        <p className="text-xs text-danger">{t("spend.none")}</p>
      )}

      <ul className="space-y-2">
        {report.stages.map((s) => {
          const selected = selectedStageId === s.stageId;
          return (
            <li key={s.stageId}>
              <button
                type="button"
                onClick={() => selectStage(s.stageId)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${
                  selected ? "border-primary bg-primary/15 ring-1 ring-primary" : "border-border bg-surface"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    {t("stages.n", { n: s.index })} · {s.quorum}
                  </span>
                  <Badge variant={s.canSpendNow ? "ok" : s.canSign ? "warn" : "danger"}>
                    {s.canSpendNow
                      ? s.amountNow > 0
                        ? t("spend.nowBtc", { btc: amt(s.amountNow) })
                        : t("spend.now")
                      : s.canSign
                        ? t("spend.wait", { n: s.blocksLeft.toLocaleString(nloc) })
                        : t("spend.needKeys")}
                  </Badge>
                </div>
                {s.canSign && s.amountNow > 0 && s.nextAmount > 0 ? (
                  <p className="mt-1 text-2xs text-fg">
                    {t("spend.nextOpens", {
                      btc: amt(s.nextAmount),
                      n: s.nextBlocks.toLocaleString(nloc),
                    })}
                  </p>
                ) : s.canSign && !s.lockOpen ? (
                  <p className="mt-1 text-2xs text-fg-muted">
                    {s.coinCount
                      ? t("spend.firstOpens", {
                          n: s.blocksLeft.toLocaleString(nloc),
                          h: s.opensAt.toLocaleString(nloc),
                          btc: amt(s.nextAmount || report.total),
                        })
                      : t("spend.lockLeft", {
                          n: s.blocksLeft.toLocaleString(nloc),
                          h: s.opensAt.toLocaleString(nloc),
                        })}
                  </p>
                ) : s.lockOpen && !s.coinCount ? (
                  <p className="mt-1 text-2xs text-fg-muted">{t("spend.lockOpen")}</p>
                ) : null}
                {s.missingMust.length ? (
                  <p className="mt-1 text-2xs text-danger">
                    {t("spend.mustHave")}: {s.missingMust.join(", ")}
                  </p>
                ) : null}
                {s.restNeed > s.restHave ? (
                  <p className="mt-1 text-2xs text-fg">
                    {t("spend.needOf", {
                      k: s.restNeed - s.restHave,
                      keys: s.restPool.join(", ") || "—",
                    })}
                  </p>
                ) : s.have.length ? (
                  <p className="mt-1 font-mono text-2xs text-fg-subtle">{s.have.join(" · ")}</p>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
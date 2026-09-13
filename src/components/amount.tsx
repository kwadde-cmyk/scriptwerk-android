import { useState, type ReactNode } from "react";
import { formatAmount, type AmountUnit } from "@/lib/hw/address-check";
import { useStudio } from "@/store/studio";
import { useT } from "@/lib/use-t";
import { numberLocale } from "@/lib/i18n";

function BtcIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="12" fill="var(--color-ink)" />
      <g
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(12 12) scale(0.72) translate(-12 -12)"
      >
        <path d="M11.767 19.089c4.924.868 6.14-6.025 1.216-6.894m-1.216 6.894L5.86 18.047m5.908 1.042-.347 1.97m1.563-8.864c4.924.869 6.14-6.025 1.215-6.893m-1.215 6.893-3.94-.694m5.155-6.2L8.29 4.26m5.908 1.042.348-1.97M7.48 20.364l3.126-17.727" />
      </g>
    </svg>
  );
}

function SatsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="12" fill="var(--color-ink)" />
      <g fill="var(--color-primary)">
        <rect x="6" y="6" width="12" height="2.35" rx="0.35" />
        <rect x="6" y="10.825" width="12" height="2.35" rx="0.35" />
        <rect x="6" y="15.65" width="12" height="2.35" rx="0.35" />
        <rect x="10.825" y="4.75" width="2.35" height="14.5" rx="0.35" />
      </g>
    </svg>
  );
}

function UnitGlyph({ kind, className = "size-4" }: { kind: "btc" | "sats"; className?: string }) {
  return kind === "sats" ? <SatsIcon className={className} /> : <BtcIcon className={className} />;
}

export function AmountText({
  btc,
  className,
  coins,
}: {
  btc: number;
  className?: string;
  coins?: boolean;
}) {
  const { locale } = useT();
  const unit = useStudio((s) => s.amountUnit);
  const [exact, setExact] = useState(false);
  const loc = numberLocale(locale);
  const f = formatAmount(btc, coins ? "btc" : unit, loc);
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 tabular-nums ${className ?? ""}`}
      title={f.exact}
      aria-label={f.exact}
      onClick={() => setExact((v) => !v)}
    >
      {exact ? (
        f.exact
      ) : (
        <>
          <span>{f.text}</span>
          <UnitGlyph kind={f.kind} />
        </>
      )}
    </button>
  );
}

export function AmountUnitSwitch() {
  const { t } = useT();
  const unit = useStudio((s) => s.amountUnit);
  const setAmountUnit = useStudio((s) => s.setAmountUnit);
  const opts: { id: AmountUnit; label: string; icon: ReactNode }[] = [
    { id: "btc", label: t("wallet.unitBtc"), icon: <BtcIcon className="size-5" /> },
    { id: "sats", label: t("wallet.unitSats"), icon: <SatsIcon className="size-5" /> },
    { id: "auto", label: t("wallet.unitAuto"), icon: null },
  ];
  return (
    <div role="group" aria-label={t("wallet.unit")} className="flex shrink-0 flex-wrap gap-1">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={unit === o.id}
          aria-label={o.label}
          title={o.label}
          onClick={() => setAmountUnit(o.id)}
          className={
            unit === o.id
              ? "inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-primary px-2 text-2xs text-primary-foreground"
              : "inline-flex h-8 min-w-8 items-center justify-center rounded-full border border-border px-2 text-2xs text-fg-muted hover:bg-muted hover:text-fg"
          }
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </div>
  );
}

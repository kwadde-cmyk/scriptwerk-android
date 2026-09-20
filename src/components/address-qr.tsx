import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Download, QrCode } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/use-t";
import { cn } from "@/lib/utils";

export function shortenAddress(value: string, head = 8, tail = 6): string {
  const s = value.trim();
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function AddressLine({
  address,
  label,
  className,
  textClassName,
}: {
  address: string;
  label?: string;
  className?: string;
  textClassName?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const text = address.trim();
  if (!text) return <span className={textClassName}>—</span>;
  const title = label?.trim() || t("addr.title");

  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-start gap-0.5", className)}>
      <button
        type="button"
        className={cn("min-w-0 text-left font-mono break-all hover:text-fg", textClassName ?? "text-2xs text-fg")}
        title={t("addr.openQr")}
        onClick={() => setOpen(true)}
      >
        {shortenAddress(text)}
      </button>
      <CopyButton value={text} label={t("addr.copy")} className="size-9" />
      <button
        type="button"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-muted hover:text-fg"
        aria-label={t("addr.openQr")}
        title={t("addr.openQr")}
        onClick={() => setOpen(true)}
      >
        <QrCode className="size-3.5" />
      </button>
      <AddressQrDialog address={text} label={title} open={open} onOpenChange={setOpen} />
    </span>
  );
}

export function AddressQrDialog({
  address,
  label,
  open,
  onOpenChange,
}: {
  address: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSrc(null);
    setError(null);
    QRCode.toDataURL(address, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 720,
      color: { dark: "#0b0c0e", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setError(t("qr.long"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, address, t]);

  function save() {
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `${label.replace(/\s+/g, "-").toLowerCase() || "address"}.png`;
    a.click();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(22rem,calc(100vw-1.5rem))] flex-col items-center gap-3 p-5">
        <DialogHeader className="mb-0 w-full text-center">
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription className="sr-only">{t("addr.openQr")}</DialogDescription>
        </DialogHeader>
        {src ? (
          <img src={src} alt={t("qr.alt", { label })} className="w-full rounded-lg bg-paper p-3" />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-border bg-surface text-xs text-fg-muted">
            {error ?? t("qr.building")}
          </div>
        )}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <p className="w-full font-mono text-2xs break-all text-fg">{address}</p>
        <div className="flex w-full items-center justify-center gap-2">
          <CopyButton value={address} label={t("addr.copy")} className="size-9" />
          <Button type="button" variant="outline" size="sm" disabled={!src} onClick={save}>
            <Download />
            {t("addr.saveQr")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

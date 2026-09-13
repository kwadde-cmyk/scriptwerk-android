import { useCallback, useEffect, useMemo, useState } from "react";
import { compileBsms, compileDescriptorCached } from "@/lib/miniscript/compile";
import { formatExportWithKeys, formatKeyList } from "@/lib/miniscript/keys";
import {
  compileBip388,
  formatBitboxJson,
  formatLedgerJson,
  formatScriptwerkJson,
  type Bip388CompileResult,
} from "@/lib/miniscript/bip388";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { QrPreview, QrScanner, FilePick } from "@/components/qr-io";
import { PolicyLibraryButton } from "@/components/policy-library";
import { RecoverySheetButton } from "@/components/recovery-sheet";
import { HardwareButton } from "@/components/hardware-usb";
import { NodeButton } from "@/components/node-rpc";
import { ScriptHighlight } from "@/components/script-view";
import { useHardware } from "@/store/hardware";
import { useT } from "@/lib/use-t";
import { Download, FolderOpen, QrCode, Redo2, RotateCcw, Share2, Undo2, Usb } from "lucide-react";
import { toast } from "sonner";
import { canShare, shareText } from "@/components/android-chrome";
import { parseLaunchIntent, stripLaunchIntent } from "@/lib/platform";

export function ImportExportBar() {
  const { t } = useT();
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const network = useStudio((s) => s.network);
  const importText = useStudio((s) => s.importText);
  const importError = useStudio((s) => s.importError);
  const reset = useStudio((s) => s.reset);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const [open, setOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [camLaunch, setCamLaunch] = useState(false);
  const walletName = useStudio((s) => s.policyName);
  const setWalletName = useStudio((s) => s.setPolicyName);

  const compiled = useMemo(
    () => compileDescriptorCached(root, keys, reuseKeys),
    [root, keys, reuseKeys],
  );
  const miniscript = compiled?.miniscript ?? "";
  const descriptor = compiled?.ok ? compiled.descriptor : "";
  const bsms = useMemo(() => (descriptor ? compileBsms(descriptor) : ""), [descriptor]);
  const bip = useMemo(
    () => (exportOpen && root ? compileBip388(root, keys, walletName, reuseKeys) : null),
    [exportOpen, root, keys, walletName, reuseKeys],
  );

  function download(filename: string, body: string) {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportFiles() {
    if (!compiled?.ok) {
      toast.error(compiled?.error ?? t("export.none"));
      return;
    }
    download("scriptwerk.keys.txt", formatKeyList(keys));
    download("scriptwerk.miniscript.txt", formatExportWithKeys(compiled.miniscript, keys));
    download("scriptwerk.descriptor.txt", formatExportWithKeys(compiled.descriptor, keys));
    download("scriptwerk.bsms", `${compileBsms(compiled.descriptor)}\n${formatExportWithKeys("", keys).trim()}`);
    download(
      "scriptwerk.json",
      formatScriptwerkJson({
        name: walletName,
        miniscript: compiled.miniscript,
        descriptor: compiled.descriptor,
        keys,
        reuseKeys,
        network,
      }),
    );
    if (bip?.ok) {
      download("scriptwerk-ledger.json", formatLedgerJson(bip.policy));
      download("scriptwerk-bitbox.json", formatBitboxJson(bip.policy));
    }
    toast.success(bip?.ok ? t("export.okDevices") : t("export.ok"));
  }

  const onQrRead = useCallback(
    (text: string) => {
      importText(text);
      const err = useStudio.getState().importError;
      if (!err) {
        setOpen(false);
        toast.success(t("import.qrOk"));
      }
    },
    [importText, t],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const intent = parseLaunchIntent(window.location.search, window.location.hash);
    if (!intent) return;
    const clean = stripLaunchIntent(new URL(window.location.href));
    window.history.replaceState(null, "", `${clean.pathname}${clean.search}${clean.hash}`);
    if (intent === "scan") {
      setCamLaunch(true);
      setOpen(true);
    }
    if (intent === "usb") useHardware.getState().setOpen(true);
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <HardwareButton />
      <NodeButton />
      <PolicyLibraryButton />
      <RecoverySheetButton />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="icon" className="size-9" aria-label={t("header.import")}>
            <FolderOpen />
          </Button>
        </DialogTrigger>
        <DialogContent className="w-[min(640px,calc(100vw-1.5rem))]">
          <DialogHeader>
            <DialogTitle>{t("import.title")}</DialogTitle>
            <DialogDescription>{t("import.blurb")}</DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="qr">
            <TabsList className="flex h-auto w-full flex-wrap">
              <TabsTrigger value="qr" className="flex-1">
                QR
              </TabsTrigger>
              <TabsTrigger value="policy" className="flex-1">
                {t("import.policy")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="qr" className="space-y-3">
              <QrScanner compact autoStart={camLaunch} onRead={onQrRead} />
              <FilePick
                onRead={(text) => {
                  setDraft(text);
                  importText(text);
                  const err = useStudio.getState().importError;
                  if (!err) {
                    setOpen(false);
                    toast.success(t("import.fileOk"));
                  }
                }}
              />
              {importError ? <p className="text-xs text-danger">{importError}</p> : null}
            </TabsContent>
            <TabsContent value="policy" className="space-y-3">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={"wsh(…)  ·  BIP-388 JSON (Ledger / BitBox)"}
                className="min-h-40"
              />
              <FilePick onRead={setDraft} />
              {importError ? <p className="text-xs text-danger">{importError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t("ops.cancel")}
                </Button>
                <Button
                  onClick={() => {
                    importText(draft);
                    const err = useStudio.getState().importError;
                    if (!err) {
                      setOpen(false);
                      toast.success(t("import.loaded"));
                    }
                  }}
                >
                  {t("import.read")}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="icon" className="size-9" aria-label={t("header.export")}>
            <QrCode />
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] w-[min(640px,calc(100vw-1.5rem))] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("export.title")}</DialogTitle>
            <DialogDescription>{t("export.blurb")}</DialogDescription>
          </DialogHeader>
          {compiled && !compiled.ok ? (
            <p className="text-sm text-danger">{compiled.error}</p>
          ) : (
            <Tabs defaultValue="descriptor">
              <TabsList className="flex h-auto w-full flex-wrap">
                <TabsTrigger value="descriptor" className="px-2.5 text-xs">
                  Descriptor
                </TabsTrigger>
                <TabsTrigger value="miniscript" className="px-2.5 text-xs">
                  Miniscript
                </TabsTrigger>
                <TabsTrigger value="ledger" className="px-2.5 text-xs">
                  {t("export.ledger")}
                </TabsTrigger>
                <TabsTrigger value="bitbox" className="px-2.5 text-xs">
                  {t("export.bitbox")}
                </TabsTrigger>
                <TabsTrigger value="bsms" className="px-2.5 text-xs">
                  BSMS
                </TabsTrigger>
              </TabsList>
              <TabsContent value="descriptor" className="space-y-3">
                <QrPreview value={descriptor} label="Descriptor" />
                <CopyText value={descriptor} />
              </TabsContent>
              <TabsContent value="miniscript" className="space-y-3">
                <QrPreview value={miniscript} label="Miniscript" />
                <CopyText value={miniscript} />
              </TabsContent>
              <TabsContent value="ledger" className="space-y-3">
                <DeviceExport
                  kind="ledger"
                  result={bip}
                  name={walletName}
                  onName={setWalletName}
                  onUsb={() => {
                    setExportOpen(false);
                    useHardware.getState().setOpen(true);
                  }}
                />
              </TabsContent>
              <TabsContent value="bitbox" className="space-y-3">
                <DeviceExport
                  kind="bitbox"
                  result={bip}
                  name={walletName}
                  onName={setWalletName}
                  onUsb={() => {
                    setExportOpen(false);
                    useHardware.getState().setOpen(true);
                  }}
                />
              </TabsContent>
              <TabsContent value="bsms" className="space-y-3">
                <QrPreview value={bsms} label="BSMS" />
                <CopyText value={bsms} />
              </TabsContent>
            </Tabs>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <ShareButtonInline title="Scriptwerk" text={descriptor || miniscript} />
            <Button variant="outline" size="sm" onClick={exportFiles}>
              <Download /> {t("export.files")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Button variant="ghost" size="icon" className="size-9" onClick={undo} disabled={!canUndo} aria-label={t("header.undo")}>
        <Undo2 />
      </Button>
      <Button variant="ghost" size="icon" className="size-9" onClick={redo} disabled={!canRedo} aria-label={t("header.redo")}>
        <Redo2 />
      </Button>
      <Button variant="ghost" size="icon" className="size-9" onClick={reset} aria-label={t("header.reset")}>
        <RotateCcw />
      </Button>
    </div>
  );
}

function DeviceExport({
  kind,
  result,
  name,
  onName,
  onUsb,
}: {
  kind: "ledger" | "bitbox";
  result: Bip388CompileResult | null;
  name: string;
  onName: (v: string) => void;
  onUsb: () => void;
}) {
  const { t } = useT();
  if (!result) return null;
  if (!result.ok) {
    return <p className="text-sm text-danger">{result.error}</p>;
  }
  const json = kind === "ledger" ? formatLedgerJson(result.policy) : formatBitboxJson(result.policy);
  const filename = kind === "ledger" ? "scriptwerk-ledger.json" : "scriptwerk-bitbox.json";

  return (
    <div className="space-y-3">
      <p className="text-xs text-pretty text-fg-muted">
        {t(kind === "ledger" ? "export.ledgerBlurb" : "export.bitboxBlurb")}
      </p>
      <div className="space-y-1">
        <Label htmlFor={`wallet-name-${kind}`}>{t("export.policyName")}</Label>
        <Input
          id={`wallet-name-${kind}`}
          value={name}
          maxLength={64}
          onChange={(e) => onName(e.target.value)}
        />
      </div>
      {result.warnings.map((w) => (
        <p key={w} className="text-xs text-warn">
          {formatWarning(w, t)}
        </p>
      ))}
      <p className="text-2xs text-fg-subtle">{t("export.register")}</p>
      <Button variant="secondary" size="sm" onClick={onUsb}>
        <Usb /> {t("export.openUsb")}
      </Button>
      <div className="space-y-1">
        <p className="text-2xs font-medium tracking-[0.14em] text-fg-subtle uppercase">
          {t("export.template")}
        </p>
        <ScriptHighlight
          value={result.policy.template}
          className="max-h-24 overflow-auto rounded-lg border border-border bg-ink px-3 py-2 font-mono text-2xs leading-relaxed break-all whitespace-pre-wrap"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(json);
            toast.success(t("read.copied"));
          }}
        >
          {t("export.copyJson")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(result.policy.template);
            toast.success(t("read.copied"));
          }}
        >
          {t("export.copyTemplate")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const blob = new Blob([json], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download /> {t("export.downloadDevice")}
        </Button>
      </div>
    </div>
  );
}

function formatWarning(w: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (w.startsWith("missingXpub:")) return t("export.needXpub", { names: w.slice("missingXpub:".length) });
  if (w.startsWith("missingFp:")) return t("export.needFp", { names: w.slice("missingFp:".length) });
  return w;
}

function CopyText({ value }: { value: string }) {
  const { t } = useT();
  if (!value) return null;
  return (
    <div className="space-y-2">
      <ScriptHighlight
        value={value}
        className="max-h-40 overflow-auto rounded-lg border border-border bg-ink px-3 py-2 font-mono text-2xs leading-relaxed break-all whitespace-pre-wrap"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(t("read.copied"));
          }}
        >
          {t("export.copy")}
        </Button>
        <ShareButtonInline title="Scriptwerk" text={value} />
      </div>
    </div>
  );
}

function ShareButtonInline({ title, text }: { title: string; text: string }) {
  const { t } = useT();
  if (!text || !canShare()) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => void shareText(title, text)}>
      <Share2 className="size-3.5" />
      {t("android.share")}
    </Button>
  );
}

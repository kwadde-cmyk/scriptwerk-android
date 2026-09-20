import { useState } from "react";
import { compiledForStudio } from "@/lib/miniscript/policy-mode";
import { deletePolicy, listPolicies, peekChecksum, savePolicy, type SavedPolicy } from "@/lib/policy-library";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "@/lib/use-t";
import { Bookmark, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function PolicyLibraryButton() {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedPolicy[]>([]);
  const policyName = useStudio((s) => s.policyName);
  const setPolicyName = useStudio((s) => s.setPolicyName);
  const loadSnapshot = useStudio((s) => s.loadSnapshot);
  const markSaved = useStudio((s) => s.markSaved);
  const root = useStudio((s) => s.root);
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const network = useStudio((s) => s.network);
  const reuseKeys = useStudio((s) => s.reuseKeys);
  const nesting = useStudio((s) => s.nesting);
  const mode = useStudio((s) => s.mode);
  const maxOlder = useStudio((s) => s.maxOlder);
  const policyMode = useStudio((s) => s.policyMode);
  const originalDescriptor = useStudio((s) => s.originalDescriptor);
  const liftWarning = useStudio((s) => s.liftWarning);
  const compiled = useStudio(compiledForStudio);

  function refresh() {
    setItems(listPolicies());
  }

  function onSave() {
    const name = policyName.trim();
    if (!name) {
      toast.error(t("library.needName"));
      return;
    }
    const checksum = compiled?.ok ? peekChecksum(compiled.descriptor) : "";
    const saved = savePolicy({
      name,
      checksum,
      network,
      snapshot: {
        keys,
        root,
        stages,
        network,
        reuseKeys,
        nesting,
        mode,
        maxOlder,
        policyName: name,
        policyMode,
        originalDescriptor,
        liftWarning,
      },
    });
    markSaved(saved.id);
    refresh();
    toast.success(t("library.saved"));
  }

  function onLoad(p: SavedPolicy) {
    loadSnapshot({ ...p.snapshot, policyName: p.name }, { id: p.id });
    setOpen(false);
    toast.success(t("library.loaded"));
  }

  function onDelete(id: string) {
    deletePolicy(id);
    if (useStudio.getState().savedId === id) {
      useStudio.setState({ savedId: null, cleanSig: "" });
    }
    refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) refresh();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" className="size-9" aria-label={t("library.title")}>
          <Bookmark />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] w-[min(640px,calc(100vw-1.5rem))] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("library.title")}</DialogTitle>
          <DialogDescription>{t("library.blurb")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            value={policyName}
            onChange={(e) => setPolicyName(e.target.value)}
            placeholder={t("library.untitled")}
            aria-label={t("library.name")}
          />
          <Button onClick={onSave} className="shrink-0">
            {t("library.save")}
          </Button>
        </div>
        <ScrollArea className="max-h-[min(420px,calc(100dvh-16rem))]">
          {items.length === 0 ? (
            <p className="py-6 text-sm text-fg-muted">{t("library.empty")}</p>
          ) : (
            <ul className="space-y-2 pr-2">
              {items.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-border bg-elevated px-3 py-2"
                >
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onLoad(p)}>
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="font-mono text-[11px] text-fg-muted">
                      {p.checksum ? `#${p.checksum}` : "—"} ·{" "}
                      {new Date(p.savedAt).toLocaleString(locale === "en" ? "en-GB" : "de-DE")}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    aria-label={t("library.delete")}
                    onClick={() => onDelete(p.id)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

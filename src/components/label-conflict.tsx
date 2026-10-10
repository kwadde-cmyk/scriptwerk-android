import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/use-t";

export function LabelConflictDialog({
  names,
  onOverwrite,
  onKeep,
  onClose,
}: {
  names: string[] | null;
  onOverwrite: () => void;
  onKeep: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={Boolean(names)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(420px,calc(100vw-1.5rem))]">
        <DialogHeader>
          <DialogTitle>{t("labels.conflictTitle")}</DialogTitle>
          <DialogDescription>{t("labels.conflict", { names: names?.join(", ") || "—" })}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onKeep}>
            {t("labels.keep")}
          </Button>
          <Button onClick={onOverwrite}>{t("labels.overwrite")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

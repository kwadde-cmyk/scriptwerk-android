import { findNode } from "@/lib/miniscript/ast";
import { useStudio } from "@/store/studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/use-t";
import { Trash2, Undo2 } from "lucide-react";

export function NodeInspector() {
  const { t } = useT();
  const root = useStudio((s) => s.root);
  const selectedId = useStudio((s) => s.selectedId);
  const patchNode = useStudio((s) => s.patchNode);
  const deleteSelected = useStudio((s) => s.deleteSelected);
  const unwrapSelected = useStudio((s) => s.unwrapSelected);
  const node = root && selectedId ? findNode(root, selectedId) : null;

  if (!node) {
    return <div className="px-4 py-4 text-xs text-fg-muted">{t("insp.empty")}</div>;
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-sm">{node.kind === "hole" ? t("insp.hole") : node.kind}</p>
        <div className="flex gap-1">
          {node.kind === "wrap" ? (
            <Button variant="ghost" size="sm" onClick={unwrapSelected}>
              <Undo2 /> {t("insp.unwrap")}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={deleteSelected}>
            <Trash2 /> {t("insp.delete")}
          </Button>
        </div>
      </div>
      {node.kind === "pk" || node.kind === "pkh" ? (
        <Field label={t("ops.key")}>
          <Input
            list="scriptwerk-keys"
            className="font-mono"
            value={node.key}
            onChange={(e) => patchNode(node.id, { key: e.target.value })}
          />
        </Field>
      ) : null}
      {node.kind === "older" || node.kind === "after" ? (
        <Field label={node.kind === "older" ? t("insp.blocks") : t("insp.height")}>
          <Input
            type="number"
            value={node.n}
            onChange={(e) => patchNode(node.id, { n: Number(e.target.value) })}
          />
        </Field>
      ) : null}
      {node.kind === "multi" ? (
        <>
          <Field label="k">
            <Input
              type="number"
              min={1}
              max={node.keys.length}
              value={node.k}
              onChange={(e) => patchNode(node.id, { k: Number(e.target.value) })}
            />
          </Field>
          <Field label={t("insp.keysCsv")}>
            <Input
              className="font-mono"
              value={node.keys.join(",")}
              onChange={(e) =>
                patchNode(node.id, {
                  keys: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
        </>
      ) : null}
      {node.kind === "thresh" ? (
        <Field label="k">
          <Input
            type="number"
            min={1}
            max={node.children.length}
            value={node.k}
            onChange={(e) => patchNode(node.id, { k: Number(e.target.value) })}
          />
        </Field>
      ) : null}
      {node.kind === "hole" ? <p className="text-xs text-fg-muted">{t("insp.fill")}</p> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

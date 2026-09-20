import { policyIsDirty } from "@/lib/policy-library";
import { useStudio } from "@/store/studio";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/use-t";
import { cn } from "@/lib/utils";

export function usePolicyTitle() {
  const { t } = useT();
  const policyName = useStudio((s) => s.policyName);
  const savedId = useStudio((s) => s.savedId);
  const dirty = useStudio((s) => policyIsDirty(s));
  const fresh = !savedId;
  const name = policyName.trim() || t("library.untitled");
  const badge = !dirty ? "" : fresh ? t("library.unsaved") : t("library.modified");
  return { name, dirty, fresh, badge };
}

export function PolicyNameHeading({ className }: { className?: string }) {
  const { name, badge } = usePolicyTitle();
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-2", className)}>
      <span className="truncate">{name}</span>
      {badge ? (
        <Badge variant="warn" className="shrink-0 uppercase tracking-[0.12em]">
          {badge}
        </Badge>
      ) : null}
    </span>
  );
}

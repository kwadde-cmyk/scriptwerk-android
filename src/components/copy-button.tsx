import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/lib/use-t";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { t } = useT();
  const [ok, setOk] = useState(false);
  const text = value.trim();
  if (!text) return null;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-muted hover:text-fg",
        className,
      )}
      aria-label={label || t("read.copy")}
      title={label || t("read.copy")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          toast.success(t("read.copied"));
          window.setTimeout(() => setOk(false), 1200);
        });
      }}
    >
      {ok ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function Copyable({
  value,
  className,
  textClassName,
  children,
}: {
  value: string;
  className?: string;
  textClassName?: string;
  children?: ReactNode;
}) {
  const text = value.trim();
  if (!text) return <span className={textClassName}>—</span>;
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-0.5", className)}>
      <span className={cn("min-w-0 truncate font-mono", textClassName)}>{children ?? text}</span>
      <CopyButton value={text} />
    </span>
  );
}

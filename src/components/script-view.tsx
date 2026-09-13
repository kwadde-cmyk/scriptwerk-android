import { useMemo } from "react";
import { highlightScript } from "@/lib/miniscript/highlight";
import { useStudio } from "@/store/studio";

export function ScriptHighlight({
  value,
  className = "max-h-[min(28rem,calc(100dvh-14rem))] overflow-auto rounded-lg border border-border bg-ink px-3 py-2 font-mono text-2xs leading-relaxed break-all whitespace-pre-wrap",
}: {
  value: string;
  className?: string;
}) {
  const keys = useStudio((s) => s.keys);
  const stages = useStudio((s) => s.stages);
  const spans = useMemo(() => highlightScript(value, keys, stages), [value, keys, stages]);
  if (!value) return null;
  return (
    <pre className={className}>
      {spans.map((s, i) => (
        <span key={i} style={{ color: s.color }}>
          {s.text}
        </span>
      ))}
    </pre>
  );
}

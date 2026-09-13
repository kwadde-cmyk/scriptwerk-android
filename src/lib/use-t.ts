import { useCallback } from "react";
import { t } from "@/lib/i18n";
import { useStudio } from "@/store/studio";

export function useT() {
  const locale = useStudio((s) => s.locale);
  const setLocale = useStudio((s) => s.setLocale);
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
  return { locale, setLocale, t: translate };
}

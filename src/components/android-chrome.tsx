import { useEffect, useState } from "react";
import { Download, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNativeCapacitor } from "@/lib/platform";
import { useT } from "@/lib/use-t";

export function isStandaloneDisplay() {
  if (typeof window === "undefined") return false;
  if (isNativeCapacitor()) return true;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function canShare() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export async function shareText(title: string, text: string): Promise<boolean> {
  if (!canShare() || !text) return false;
  try {
    await navigator.share({ title, text });
    return true;
  } catch {
    return false;
  }
}

const DISMISS_KEY = "scriptwerk-install-dismissed";

export function AndroidInstallBanner() {
  const { t } = useT();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (isStandaloneDisplay()) {
      setHidden(true);
      return;
    }
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") setHidden(true);
    } catch {
      /* ignore */
    }
  }, []);

  if (hidden) return null;

  function dismiss() {
    setHidden(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex items-start gap-3 border-b border-border bg-elevated px-3 py-2.5">
      <img src="/favicon.svg" alt="" className="mt-0.5 size-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{t("android.install")}</p>
        <p className="mt-0.5 text-2xs text-pretty text-fg-muted">{t("android.installBlurb")}</p>
        <Button size="sm" className="mt-2 h-8 whitespace-nowrap px-3" asChild>
          <a href="/Scriptwerk.apk" download="Scriptwerk.apk">
            <Download className="size-3.5" />
            {t("android.installNow")}
          </a>
        </Button>
      </div>
      <button
        type="button"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-muted hover:text-fg"
        aria-label={t("android.dismiss")}
        onClick={dismiss}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function ShareButton({ title, text }: { title: string; text: string }) {
  const { t } = useT();
  if (!text || !canShare()) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => void shareText(title, text)}>
      <Share2 className="size-3.5" />
      {t("android.share")}
    </Button>
  );
}

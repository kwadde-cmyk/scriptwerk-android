import { isMobileUA, isNativeCapacitor } from "../platform.ts";

type CapacitorHttpPlugin = {
  request: (opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
    responseType?: "text" | "json" | "blob" | "arraybuffer";
  }) => Promise<{ data: unknown; status: number; headers: Record<string, string> }>;
};

function headerMap(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  const headers = new Headers(init);
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Android WebView fetch is CORS-bound. CapacitorHttp talks to LAN Core without a tab-bridge. */
export async function nativeHttp(url: string, init: RequestInit = {}): Promise<Response> {
  const { CapacitorHttp } = (await import("@capacitor/core")) as unknown as { CapacitorHttp: CapacitorHttpPlugin };
  const headers = headerMap(init.headers);
  let data: unknown = init.body ?? undefined;
  if (typeof data === "string" && /json/i.test(headers["Content-Type"] || headers["content-type"] || "")) {
    try {
      data = JSON.parse(data);
    } catch {
      /* send as text */
    }
  }
  const res = await withDeadline(
    CapacitorHttp.request({
      url,
      method: init.method || "GET",
      headers,
      data,
      connectTimeout: 8000,
      readTimeout: 8000,
      responseType: "text",
    }),
    10000,
    "node.err.unreachable",
  );
  const raw =
    typeof res.data === "string" ? res.data : res.data == null ? "" : JSON.stringify(res.data);
  return new Response(raw, {
    status: res.status || 0,
    headers: res.headers || {},
  });
}

export function nativeRpcAvailable(): boolean {
  return isNativeCapacitor();
}

/** Bookmarklet / Node-Tab bridge is unusable on a phone. Native APK uses CapacitorHttp instead. */
export function skipNodeBridge(): boolean {
  return isNativeCapacitor() || isMobileUA();
}

import { hwErrorMessage, type HwKind } from "./types.ts";

const LEDGER_VENDOR = 0x2c97;
const BITBOX_VENDOR = 0x03eb;
const BITBOX_PRODUCTS = new Set([0x2402, 0x2403]);

export type HidIdentity = { vendorId: number; productId: number; productName?: string };

export function hidKind(device: HidIdentity): HwKind | null {
  if (device.vendorId === LEDGER_VENDOR) return "ledger";
  if (/bitbox/i.test(device.productName || "")) return "bitbox";
  if (device.vendorId === BITBOX_VENDOR && BITBOX_PRODUCTS.has(device.productId)) return "bitbox";
  return null;
}

type HidApi = {
  getDevices: () => Promise<HidIdentity[]>;
  requestDevice: (opts: { filters: { vendorId: number; productId?: number }[] }) => Promise<HidIdentity[]>;
};

function hidApi(): HidApi {
  const hid = (navigator as Navigator & { hid?: HidApi }).hid;
  if (!hid) throw new Error("hw.err.hid");
  return hid;
}

/** One USB button: a granted device is used as-is, otherwise the browser picker covers both. */
export async function pickUsbKind(): Promise<HwKind> {
  const hid = hidApi();
  const filters = [
    { vendorId: LEDGER_VENDOR },
    { vendorId: BITBOX_VENDOR, productId: 0x2403 },
    { vendorId: BITBOX_VENDOR, productId: 0x2402 },
  ];
  let granted: HwKind[] = [];
  try {
    granted = (await hid.getDevices()).map(hidKind).filter((k): k is HwKind => Boolean(k));
  } catch {
    granted = [];
  }
  const unique = [...new Set(granted)];
  if (unique.length === 1) return unique[0]!;
  try {
    const requested = await hid.requestDevice({ filters });
    const kind = requested.map(hidKind).find((k): k is HwKind => Boolean(k));
    if (!kind) throw new Error("hw.err.none");
    return kind;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("hw.err.")) throw err;
    throw new Error(hwErrorMessage(err));
  }
}

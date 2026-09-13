import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { exactBuffer, fromHex, matchUsbFilter, toHex, type UsbFilter } from "./usb-util";

export type NativeUsbDevice = {
  deviceId: string;
  vendorId: number;
  productId: number;
  productName: string;
  manufacturerName: string;
  hasPermission?: boolean;
};

type NativeInterface = {
  interfaceNumber: number;
  interfaceClass: number;
  endpoints: { number: number; in: boolean; type: number; packetSize: number }[];
};

type UsbHostPlugin = {
  list(): Promise<{ devices: NativeUsbDevice[] }>;
  open(opts: { vendorId?: number; productId?: number; mode: "hid" | "webusb" }): Promise<{
    device: NativeUsbDevice;
    interfaces: NativeInterface[];
    mode: string;
  }>;
  close(): Promise<void>;
  transferOut(opts: { endpoint: number; hex: string; timeoutMs?: number }): Promise<void>;
  transferIn(opts: { endpoint: number; length: number; timeoutMs?: number }): Promise<{ hex: string }>;
  hidWrite(opts: { reportId: number; hex: string }): Promise<void>;
  addListener(
    event: "hidInput" | "disconnect",
    cb: (ev: { hex?: string; reportId?: number; deviceId?: string }) => void,
  ): Promise<PluginListenerHandle>;
};

const UsbHost = registerPlugin<UsbHostPlugin>("UsbHost");

class MiniTarget {
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  addEventListener(type: string, fn: (ev: unknown) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

let hidInputHandle: PluginListenerHandle | null = null;
let disconnectHandle: PluginListenerHandle | null = null;
const hidTarget = new MiniTarget();
const usbTarget = new MiniTarget();
let hidOpened: HidDevicePolyfill | null = null;
let usbOpened: UsbDevicePolyfill | null = null;

class HidDevicePolyfill {
  vendorId: number;
  productId: number;
  productName: string;
  manufacturerName: string;
  opened = false;
  collections: unknown[] = [];
  private target = new MiniTarget();

  constructor(info: NativeUsbDevice) {
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName;
    this.manufacturerName = info.manufacturerName;
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.target.addEventListener(type, fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.target.removeEventListener(type, fn);
  }

  onInput(hex: string, reportId = 0) {
    const bytes = fromHex(hex);
    const data = new DataView(exactBuffer(bytes));
    this.target.dispatchEvent("inputreport", { data, reportId, device: this });
  }

  async open() {
    const res = await UsbHost.open({
      vendorId: this.vendorId,
      productId: this.productId,
      mode: "hid",
    });
    this.vendorId = res.device.vendorId;
    this.productId = res.device.productId;
    this.productName = res.device.productName;
    this.opened = true;
    hidOpened = this;
  }

  async close() {
    this.opened = false;
    if (hidOpened === this) hidOpened = null;
    await UsbHost.close().catch(() => undefined);
  }

  async sendReport(reportId: number, data: BufferSource) {
    await UsbHost.hidWrite({ reportId: reportId ?? 0, hex: toHex(data as ArrayBufferView) });
  }
}

class UsbDevicePolyfill {
  vendorId: number;
  productId: number;
  productName: string;
  manufacturerName: string;
  configuration: { configurationValue: number; interfaces: ReturnType<UsbDevicePolyfill["mapInterfaces"]> } | null =
    null;
  configurations: { configurationValue: number; interfaces: ReturnType<UsbDevicePolyfill["mapInterfaces"]> }[] = [];
  opened = false;

  constructor(info: NativeUsbDevice) {
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName;
    this.manufacturerName = info.manufacturerName;
  }

  private mapInterfaces(list: NativeInterface[]) {
    return list.map((intf) => ({
      interfaceNumber: intf.interfaceNumber,
      claimed: false,
      alternates: [
        {
          interfaceClass: intf.interfaceClass,
          endpoints: intf.endpoints.map((ep) => ({
            endpointNumber: ep.number,
            direction: ep.in ? "in" : "out",
            type: ep.type === 3 ? "interrupt" : "bulk",
            packetSize: ep.packetSize,
          })),
        },
      ],
    }));
  }

  async open() {
    const res = await UsbHost.open({
      vendorId: this.vendorId,
      productId: this.productId,
      mode: "webusb",
    });
    this.vendorId = res.device.vendorId;
    this.productId = res.device.productId;
    this.productName = res.device.productName;
    const interfaces = this.mapInterfaces(res.interfaces ?? []);
    this.configuration = { configurationValue: 1, interfaces };
    this.configurations = [this.configuration];
    this.opened = true;
    usbOpened = this;
  }

  async selectConfiguration(_value: number) {
    /* Android openDevice already configured the device. */
  }

  async claimInterface(_n: number) {
    /* claimed natively on open */
  }

  async releaseInterface(_n: number) {
    /* released on close */
  }

  async reset() {
    /* skip — reset drops the Android connection */
  }

  async transferOut(endpoint: number, data: BufferSource) {
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    await UsbHost.transferOut({ endpoint, hex: toHex(bytes), timeoutMs: 120000 });
    return { bytesWritten: bytes.length, status: "ok" };
  }

  async transferIn(endpoint: number, length: number) {
    const r = await UsbHost.transferIn({ endpoint, length, timeoutMs: 120000 });
    const bytes = fromHex(r.hex ?? "");
    const buffer = exactBuffer(bytes);
    return { data: { buffer }, status: "ok" };
  }

  async close() {
    this.opened = false;
    if (usbOpened === this) usbOpened = null;
    await UsbHost.close().catch(() => undefined);
  }
}

async function listFiltered(filters?: UsbFilter[]): Promise<NativeUsbDevice[]> {
  const { devices } = await UsbHost.list();
  const exact = (devices ?? []).filter((d) => matchUsbFilter(d, filters));
  if (exact.length) return exact;
  if (!filters?.length) return devices ?? [];
  return (devices ?? []).filter((d) => filters.some((f) => f.vendorId == null || f.vendorId === d.vendorId));
}

export async function installUsbPolyfill() {
  if (typeof navigator === "undefined") return;
  if (!hidInputHandle) {
    hidInputHandle = await UsbHost.addListener("hidInput", (ev) => {
      if (hidOpened && ev.hex) hidOpened.onInput(ev.hex, ev.reportId ?? 0);
    });
  }
  if (!disconnectHandle) {
    disconnectHandle = await UsbHost.addListener("disconnect", (ev) => {
      const payload = { device: hidOpened ?? usbOpened };
      hidTarget.dispatchEvent("disconnect", payload);
      usbTarget.dispatchEvent("disconnect", payload);
      hidOpened = null;
      usbOpened = null;
      void ev;
    });
  }

  const hid = {
    getDevices: async (opts?: { filters?: UsbFilter[] }) => {
      const list = await listFiltered(opts?.filters);
      return list.map((d) => new HidDevicePolyfill(d));
    },
    requestDevice: async (opts?: { filters?: UsbFilter[] }) => {
      const filter = opts?.filters?.[0];
      const res = await UsbHost.open({
        vendorId: filter?.vendorId,
        productId: filter?.productId,
        mode: "hid",
      });
      await UsbHost.close().catch(() => undefined);
      const device = new HidDevicePolyfill(res.device);
      return [device];
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => hidTarget.addEventListener(type, fn),
    removeEventListener: (type: string, fn: (ev: unknown) => void) => hidTarget.removeEventListener(type, fn),
  };

  const usb = {
    getDevices: async (opts?: { filters?: UsbFilter[] }) => {
      const list = await listFiltered(opts?.filters);
      return list.map((d) => new UsbDevicePolyfill(d));
    },
    requestDevice: async (opts?: { filters?: UsbFilter[] }) => {
      const filter = opts?.filters?.[0];
      const res = await UsbHost.open({
        vendorId: filter?.vendorId,
        productId: filter?.productId,
        mode: "webusb",
      });
      await UsbHost.close().catch(() => undefined);
      return new UsbDevicePolyfill(res.device);
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => usbTarget.addEventListener(type, fn),
    removeEventListener: (type: string, fn: (ev: unknown) => void) => usbTarget.removeEventListener(type, fn),
  };

  Object.defineProperty(navigator, "hid", { configurable: true, value: hid });
  Object.defineProperty(navigator, "usb", { configurable: true, value: usb });
}

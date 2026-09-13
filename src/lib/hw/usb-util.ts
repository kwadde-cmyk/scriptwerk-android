export type UsbFilter = { vendorId?: number; productId?: number };

export function toHex(data: ArrayBuffer | ArrayBufferView): string {
  const u8 =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let out = "";
  for (let i = 0; i < u8.length; i++) out += u8[i]!.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function exactBuffer(u8: Uint8Array): ArrayBuffer {
  return Uint8Array.from(u8).buffer;
}

export function matchUsbFilter(device: { vendorId: number; productId: number }, filters?: UsbFilter[]): boolean {
  if (!filters?.length) return true;
  return filters.some(
    (f) =>
      (f.vendorId == null || f.vendorId === device.vendorId) &&
      (f.productId == null || f.productId === device.productId),
  );
}

package app.scriptwerk.android;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "UsbHost")
public class UsbHostPlugin extends Plugin {
    private static final String ACTION_USB_PERMISSION = "app.scriptwerk.android.USB_PERMISSION";
    private static final int HID_TIMEOUT_MS = 80;
    private static final int XFER_TIMEOUT_MS = 120000;

    private UsbManager usbManager;
    private UsbDeviceConnection connection;
    private UsbDevice openDevice;
    private UsbInterface claimedInterface;
    private UsbEndpoint bulkOut;
    private UsbEndpoint bulkIn;
    private UsbEndpoint hidOut;
    private UsbEndpoint hidIn;
    private String mode = "hid";
    private volatile boolean hidLoop = false;
    private Thread hidThread;
    private PluginCall pendingPermission;
    private String pendingMode = "hid";
    private final Object usbLock = new Object();
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (ACTION_USB_PERMISSION.equals(action)) {
                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                PluginCall call = pendingPermission;
                pendingPermission = null;
                if (call == null) return;
                if (!granted || device == null) {
                    call.reject("USB permission denied");
                    return;
                }
                io.execute(() -> {
                    try {
                        call.resolve(openNow(device, pendingMode));
                    } catch (Exception e) {
                        call.reject(e.getMessage());
                    }
                });
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (device != null && openDevice != null && device.getDeviceId() == openDevice.getDeviceId()) {
                    JSObject ev = new JSObject();
                    ev.put("deviceId", String.valueOf(device.getDeviceId()));
                    notifyListeners("disconnect", ev);
                    io.execute(UsbHostPlugin.this::closeQuietly);
                }
            }
        }
    };

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        hidLoop = false;
        closeQuietly();
        try {
            getContext().unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
        io.shutdownNow();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray devices = new JSArray();
        if (usbManager != null) {
            for (UsbDevice device : usbManager.getDeviceList().values()) {
                if (isKnownWallet(device)) {
                    devices.put(deviceJson(device));
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        call.resolve(ret);
    }

    @PluginMethod
    public void open(PluginCall call) {
        int vendorId = call.getInt("vendorId", 0);
        int productId = call.getInt("productId", 0);
        String requestedMode = call.getString("mode", "hid");
        UsbDevice device = findDevice(vendorId, productId);
        if (device == null) {
            call.reject("No USB device");
            return;
        }
        if (usbManager.hasPermission(device)) {
            io.execute(() -> {
                try {
                    call.resolve(openNow(device, requestedMode));
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            });
            return;
        }
        call.setKeepAlive(true);
        pendingPermission = call;
        pendingMode = requestedMode;
        Intent intent = new Intent(ACTION_USB_PERMISSION);
        intent.setPackage(getContext().getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(getContext(), 0, intent, flags);
        usbManager.requestPermission(device, pi);
    }

    @PluginMethod
    public void close(PluginCall call) {
        io.execute(() -> {
            closeQuietly();
            call.resolve();
        });
    }

    @PluginMethod
    public void transferOut(PluginCall call) {
        int endpoint = call.getInt("endpoint", 0);
        String hex = call.getString("hex", "");
        int timeout = call.getInt("timeoutMs", XFER_TIMEOUT_MS);
        io.execute(() -> {
            try {
                byte[] data = fromHex(hex);
                synchronized (usbLock) {
                    UsbEndpoint ep = endpointByNumber(endpoint, false);
                    if (ep == null || connection == null) throw new IllegalStateException("USB not open");
                    int n = connection.bulkTransfer(ep, data, data.length, timeout);
                    if (n < 0) throw new IllegalStateException("USB write failed");
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void transferIn(PluginCall call) {
        int endpoint = call.getInt("endpoint", 0);
        int length = call.getInt("length", 64);
        int timeout = call.getInt("timeoutMs", XFER_TIMEOUT_MS);
        io.execute(() -> {
            try {
                byte[] buf = new byte[Math.max(length, 64)];
                int n;
                synchronized (usbLock) {
                    UsbEndpoint ep = endpointByNumber(endpoint, true);
                    if (ep == null || connection == null) throw new IllegalStateException("USB not open");
                    n = connection.bulkTransfer(ep, buf, Math.min(length, buf.length), timeout);
                    if (n < 0) throw new IllegalStateException("USB read failed");
                }
                JSObject ret = new JSObject();
                ret.put("hex", toHex(buf, Math.max(n, 0)));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void hidWrite(PluginCall call) {
        int reportId = call.getInt("reportId", 0);
        String hex = call.getString("hex", "");
        io.execute(() -> {
            try {
                writeHid(reportId, fromHex(hex));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    private JSObject openNow(UsbDevice device, String requestedMode) {
        synchronized (usbLock) {
            closeQuietlyLocked();
            connection = usbManager.openDevice(device);
            if (connection == null) {
                throw new IllegalStateException("Could not open USB device");
            }
            openDevice = device;
            mode = requestedMode == null ? "hid" : requestedMode;
            pickEndpoints(device, mode);
            if (claimedInterface != null) {
                if (!connection.claimInterface(claimedInterface, true)) {
                    throw new IllegalStateException("Could not claim USB interface");
                }
            }
            JSObject ret = new JSObject();
            ret.put("device", deviceJson(device));
            ret.put("interfaces", interfacesJson(device));
            ret.put("mode", mode);
            if ("hid".equals(mode)) startHidLoop();
            return ret;
        }
    }

    private void pickEndpoints(UsbDevice device, String requestedMode) {
        bulkIn = null;
        bulkOut = null;
        hidIn = null;
        hidOut = null;
        claimedInterface = null;
        UsbInterface vendor = findInterface(device, 255);
        UsbInterface hid = findInterface(device, UsbConstants.USB_CLASS_HID);
        UsbInterface chosen = "webusb".equals(requestedMode)
            ? (vendor != null ? vendor : hid)
            : (hid != null ? hid : vendor);
        if (chosen == null && device.getInterfaceCount() > 0) {
            chosen = device.getInterface(0);
        }
        claimedInterface = chosen;
        if (chosen == null) return;
        for (int i = 0; i < chosen.getEndpointCount(); i++) {
            UsbEndpoint ep = chosen.getEndpoint(i);
            boolean in = ep.getDirection() == UsbConstants.USB_DIR_IN;
            int type = ep.getType();
            if (type == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                if (in && bulkIn == null) bulkIn = ep;
                if (!in && bulkOut == null) bulkOut = ep;
            } else if (type == UsbConstants.USB_ENDPOINT_XFER_INT) {
                if (in && hidIn == null) hidIn = ep;
                if (!in && hidOut == null) hidOut = ep;
            }
        }
        if (hidIn == null) hidIn = bulkIn;
        if (hidOut == null) hidOut = bulkOut;
        if (bulkIn == null) bulkIn = hidIn;
        if (bulkOut == null) bulkOut = hidOut;
    }

    private UsbInterface findInterface(UsbDevice device, int classId) {
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface intf = device.getInterface(i);
            if (intf.getInterfaceClass() == classId) return intf;
        }
        return null;
    }

    private UsbEndpoint endpointByNumber(int number, boolean in) {
        UsbEndpoint[] candidates = in
            ? new UsbEndpoint[] { bulkIn, hidIn }
            : new UsbEndpoint[] { bulkOut, hidOut };
        UsbEndpoint fallback = null;
        for (UsbEndpoint ep : candidates) {
            if (ep == null) continue;
            if (fallback == null) fallback = ep;
            if (ep.getEndpointNumber() == number) return ep;
        }
        return fallback;
    }

    private void writeHid(int reportId, byte[] payload) {
        synchronized (usbLock) {
            if (connection == null) throw new IllegalStateException("USB not open");
            byte[] data = payload;
            int pkt = hidOut != null ? hidOut.getMaxPacketSize() : (hidIn != null ? hidIn.getMaxPacketSize() : 64);
            if (pkt <= 0) pkt = 64;
            if (data.length < pkt) {
                byte[] padded = new byte[pkt];
                System.arraycopy(data, 0, padded, 0, data.length);
                data = padded;
            }
            if (hidOut != null) {
                int n = connection.bulkTransfer(hidOut, data, data.length, 2000);
                if (n < 0) throw new IllegalStateException("HID write failed");
                return;
            }
            if (claimedInterface == null) throw new IllegalStateException("No HID interface");
            int requestType = UsbConstants.USB_DIR_OUT | 0x20 | 0x01;
            int value = (2 << 8) | (reportId & 0xff);
            int n = connection.controlTransfer(
                requestType, 0x09, value, claimedInterface.getId(), data, data.length, 2000);
            if (n < 0) throw new IllegalStateException("HID SET_REPORT failed");
        }
    }

    private void startHidLoop() {
        hidLoop = true;
        hidThread = new Thread(() -> {
            byte[] buf = new byte[64];
            while (hidLoop) {
                int n = -2;
                synchronized (usbLock) {
                    if (!hidLoop || connection == null || hidIn == null) break;
                    buf = new byte[Math.max(64, hidIn.getMaxPacketSize())];
                    n = connection.bulkTransfer(hidIn, buf, buf.length, HID_TIMEOUT_MS);
                }
                if (n > 0) {
                    JSObject ev = new JSObject();
                    ev.put("hex", toHex(buf, n));
                    ev.put("reportId", 0);
                    notifyListeners("hidInput", ev);
                } else if (n < 0 && n != -1) {
                    /* timeout / interrupt */
                }
            }
        }, "scriptwerk-hid");
        hidThread.setDaemon(true);
        hidThread.start();
    }

    private void closeQuietly() {
        synchronized (usbLock) {
            closeQuietlyLocked();
        }
    }

    private void closeQuietlyLocked() {
        hidLoop = false;
        Thread t = hidThread;
        hidThread = null;
        if (t != null) {
            try {
                t.join(200);
            } catch (InterruptedException ignored) {
            }
        }
        if (connection != null) {
            try {
                if (claimedInterface != null) connection.releaseInterface(claimedInterface);
            } catch (Exception ignored) {
            }
            try {
                connection.close();
            } catch (Exception ignored) {
            }
        }
        connection = null;
        openDevice = null;
        claimedInterface = null;
        bulkIn = null;
        bulkOut = null;
        hidIn = null;
        hidOut = null;
    }

    private UsbDevice findDevice(int vendorId, int productId) {
        if (usbManager == null) return null;
        UsbDevice fallback = null;
        for (UsbDevice device : usbManager.getDeviceList().values()) {
            if (!isKnownWallet(device)) continue;
            if (vendorId != 0 && device.getVendorId() != vendorId) continue;
            if (productId != 0 && device.getProductId() == productId) return device;
            if (productId == 0) return device;
            if (fallback == null) fallback = device;
        }
        if (vendorId != 0 && fallback != null && fallback.getVendorId() == vendorId) return fallback;
        return fallback;
    }

    private static boolean isKnownWallet(UsbDevice device) {
        int vid = device.getVendorId();
        if (vid == 0x2c97 || vid == 0x03eb || vid == 0x1209) return true;
        String name = device.getProductName();
        return name != null && (name.contains("Ledger") || name.contains("BitBox") || name.contains("Nano"));
    }

    private JSObject deviceJson(UsbDevice device) {
        JSObject o = new JSObject();
        o.put("deviceId", String.valueOf(device.getDeviceId()));
        o.put("vendorId", device.getVendorId());
        o.put("productId", device.getProductId());
        String product = device.getProductName();
        if (product == null || product.isEmpty()) {
            if (device.getVendorId() == 0x03eb || device.getVendorId() == 0x1209) product = "BitBox02";
            else if (device.getVendorId() == 0x2c97) product = "Ledger";
            else product = "USB device";
        }
        if (device.getVendorId() == 0x03eb && !product.contains("BitBox02")) {
            product = "BitBox02";
        }
        o.put("productName", product);
        String mfg = device.getManufacturerName();
        o.put("manufacturerName", mfg == null ? "" : mfg);
        o.put("hasPermission", usbManager != null && usbManager.hasPermission(device));
        return o;
    }

    private JSArray interfacesJson(UsbDevice device) {
        JSArray list = new JSArray();
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface intf = device.getInterface(i);
            JSObject o = new JSObject();
            o.put("interfaceNumber", intf.getId());
            o.put("interfaceClass", intf.getInterfaceClass());
            JSArray eps = new JSArray();
            for (int e = 0; e < intf.getEndpointCount(); e++) {
                UsbEndpoint ep = intf.getEndpoint(e);
                JSObject pe = new JSObject();
                pe.put("number", ep.getEndpointNumber());
                pe.put("in", ep.getDirection() == UsbConstants.USB_DIR_IN);
                pe.put("type", ep.getType());
                pe.put("packetSize", ep.getMaxPacketSize());
                eps.put(pe);
            }
            o.put("endpoints", eps);
            list.put(o);
        }
        return list;
    }

    private static String toHex(byte[] data, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = 0; i < len; i++) {
            sb.append(String.format(Locale.US, "%02x", data[i] & 0xff));
        }
        return sb.toString();
    }

    private static byte[] fromHex(String hex) {
        if (hex == null) return new byte[0];
        String h = hex.trim();
        if ((h.length() & 1) == 1) h = "0" + h;
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}

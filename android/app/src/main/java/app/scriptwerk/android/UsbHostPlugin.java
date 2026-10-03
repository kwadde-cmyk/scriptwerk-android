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
    private UsbDevice pendingDevice;
    private String pendingMode = "hid";
    private final Object usbLock = new Object();
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                UsbDevice device = readDevice(intent);
                if (device != null && openDevice != null && device.getDeviceId() == openDevice.getDeviceId()) {
                    JSObject ev = new JSObject();
                    ev.put("deviceId", String.valueOf(device.getDeviceId()));
                    notifyListeners("disconnect", ev);
                    io.execute(UsbHostPlugin.this::closeQuietly);
                }
            }
        }
    };

    private void handlePermission(Intent intent) {
        UsbDevice fromIntent = readDevice(intent);
        final UsbDevice device = fromIntent != null ? fromIntent : pendingDevice;
        pendingDevice = null;
        boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
        PluginCall call = pendingPermission;
        pendingPermission = null;
        if (call == null) return;
        if (!granted || device == null) {
            call.reject("USB permission denied");
            return;
        }
        final String mode = pendingMode;
        io.execute(() -> {
            try {
                call.resolve(openNow(device, mode));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    private static UsbHostPlugin instance;

    @Override
    public void load() {
        instance = this;
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter filter = new IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    static void deliverPermission(Intent intent) {
        UsbHostPlugin self = instance;
        if (self != null) self.handlePermission(intent);
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
        pendingDevice = device;
        pendingMode = requestedMode;
        Intent intent = new Intent(getContext(), UsbPermissionReceiver.class);
        intent.setAction(ACTION_USB_PERMISSION);
        intent.setPackage(getContext().getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(getContext(), device.getDeviceId(), intent, flags);
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
        closeQuietly();
        synchronized (usbLock) {
            connection = usbManager.openDevice(device);
            if (connection == null) {
                throw new IllegalStateException("Could not open USB device");
            }
            openDevice = device;
            mode = requestedMode == null ? "hid" : requestedMode;
            claimedInterface = chooseInterface(device, mode);
            pickEndpoints(claimedInterface);
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

    /** Ledger APDU lives on the HID interface whose report descriptor usage page is 0xFFA0, not the first HID interface. */
    private UsbInterface chooseInterface(UsbDevice device, String requestedMode) {
        if ("webusb".equals(requestedMode)) {
            UsbInterface vendor = findInterface(device, 255);
            if (vendor != null) return vendor;
        }
        UsbInterface ledger = null;
        UsbInterface lastHid = null;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface intf = device.getInterface(i);
            if (intf.getInterfaceClass() != UsbConstants.USB_CLASS_HID) continue;
            lastHid = intf;
            if (hasLedgerUsage(intf)) {
                ledger = intf;
                break;
            }
        }
        if (ledger != null) return ledger;
        if (lastHid != null) return lastHid;
        UsbInterface vendor = findInterface(device, 255);
        if (vendor != null) return vendor;
        return device.getInterfaceCount() > 0 ? device.getInterface(0) : null;
    }

    private boolean hasLedgerUsage(UsbInterface intf) {
        if (connection == null) return false;
        byte[] buf = new byte[512];
        int len = connection.controlTransfer(0x81, 0x06, 0x2200, intf.getId(), buf, buf.length, 1000);
        if (len < 3) return false;
        for (int i = 0; i + 2 < len; i++) {
            if ((buf[i] & 0xff) == 0x06 && (buf[i + 1] & 0xff) == 0xa0 && (buf[i + 2] & 0xff) == 0xff) return true;
        }
        return false;
    }

    private void pickEndpoints(UsbInterface chosen) {
        bulkIn = null;
        bulkOut = null;
        hidIn = null;
        hidOut = null;
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
            if (connection == null || claimedInterface == null) throw new IllegalStateException("USB not open");
            byte[] data = new byte[64];
            System.arraycopy(payload, 0, data, 0, Math.min(payload.length, 64));
            // SET_REPORT is what the Bitcoin app reads. A raw interrupt write on the other interface is ignored.
            int value = (2 << 8) | (reportId & 0xff);
            int n = connection.controlTransfer(0x21, 0x09, value, claimedInterface.getId(), data, data.length, 2000);
            if (n < 0 && hidOut != null) {
                n = connection.bulkTransfer(hidOut, data, data.length, 2000);
            }
            if (n < 0) throw new IllegalStateException("HID write failed");
        }
    }

    private void startHidLoop() {
        hidLoop = true;
        hidThread = new Thread(() -> {
            byte[] buf = new byte[64];
            while (hidLoop) {
                int n;
                synchronized (usbLock) {
                    if (!hidLoop || connection == null || hidIn == null) break;
                    n = connection.bulkTransfer(hidIn, buf, 64, HID_TIMEOUT_MS);
                }
                if (n == 64 || (n > 0 && n < 64)) {
                    JSObject ev = new JSObject();
                    ev.put("hex", toHex(buf, n));
                    ev.put("reportId", 0);
                    notifyListeners("hidInput", ev);
                }
            }
        }, "scriptwerk-hid");
        hidThread.setDaemon(true);
        hidThread.start();
    }

    private void closeQuietly() {
        Thread t;
        synchronized (usbLock) {
            hidLoop = false;
            t = hidThread;
            hidThread = null;
        }
        if (t != null) {
            try {
                t.join(400);
            } catch (InterruptedException ignored) {
            }
        }
        synchronized (usbLock) {
            releaseConnectionLocked();
        }
    }

    private void closeQuietlyLocked() {
        hidLoop = false;
        hidThread = null;
        releaseConnectionLocked();
    }

    private void releaseConnectionLocked() {
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

    private static UsbDevice readDevice(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
        }
        return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
    }

    private static String toHex(byte[] data, int off, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        int end = Math.min(data.length, off + len);
        for (int i = off; i < end; i++) {
            sb.append(String.format(Locale.US, "%02x", data[i] & 0xff));
        }
        return sb.toString();
    }

    private static String toHex(byte[] data, int len) {
        return toHex(data, 0, len);
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

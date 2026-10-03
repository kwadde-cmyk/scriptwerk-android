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
import android.hardware.usb.UsbRequest;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "UsbHost")
public class UsbHostPlugin extends Plugin {
    private static final String TAG = "ScriptwerkUsb";
    private static final String ACTION_USB_PERMISSION = "app.scriptwerk.android.USB_PERMISSION";
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
    private volatile UsbRequest hidRequest;
    private Thread hidThread;
    private PluginCall pendingPermission;
    private UsbDevice pendingDevice;
    private String pendingMode = "hid";
    private final Object usbLock = new Object();
    private final Object permLock = new Object();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final LinkedBlockingQueue<HidOut> hidOutQueue = new LinkedBlockingQueue<>();

    private static final class HidOut {
        final byte[] data;
        final int reportId;
        final CompletableFuture<Void> done;

        HidOut(byte[] data, int reportId, CompletableFuture<Void> done) {
            this.data = data;
            this.reportId = reportId;
            this.done = done;
        }
    }

    private final BroadcastReceiver detachReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) return;
            UsbDevice device = readDevice(intent);
            if (device != null && openDevice != null && device.getDeviceId() == openDevice.getDeviceId()) {
                JSObject ev = new JSObject();
                ev.put("deviceId", String.valueOf(device.getDeviceId()));
                notifyListeners("disconnect", ev);
                io.execute(UsbHostPlugin.this::closeQuietly);
            }
        }
    };

    private final BroadcastReceiver permissionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            handlePermission(intent);
        }
    };

    private void handlePermission(Intent intent) {
        if (intent == null) return;
        boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
        UsbDevice fromIntent = readDevice(intent);
        final UsbDevice device = fromIntent != null ? fromIntent : pendingDevice;
        Log.i(TAG, "permission result granted=" + granted + " hasDevice=" + (device != null));
        if (device != null && usbManager != null && usbManager.hasPermission(device)) {
            finishPermission(device);
            return;
        }
        if (granted && device != null) finishPermission(device);
    }

    private void finishPermission(UsbDevice device) {
        final PluginCall call;
        final String openMode;
        synchronized (permLock) {
            call = pendingPermission;
            if (call == null || device == null) return;
            pendingPermission = null;
            openMode = pendingMode;
            pendingDevice = null;
        }
        io.execute(() -> {
            try {
                call.resolve(openNow(device, openMode));
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "USB open failed" : e.getMessage());
            }
        });
    }

    private void startPermissionWatch(final UsbDevice device, final PluginCall call) {
        Thread watch = new Thread(() -> {
            for (int i = 0; i < 100; i++) {
                synchronized (permLock) {
                    if (pendingPermission != call) return;
                }
                if (usbManager != null && usbManager.hasPermission(device)) {
                    Log.i(TAG, "permission visible via hasPermission");
                    finishPermission(device);
                    return;
                }
                try {
                    Thread.sleep(200);
                } catch (InterruptedException e) {
                    return;
                }
            }
            synchronized (permLock) {
                if (pendingPermission != call) return;
                pendingPermission = null;
                pendingDevice = null;
            }
            call.reject("USB permission denied");
        }, "scriptwerk-usb-perm");
        watch.setDaemon(true);
        watch.start();
    }

    private static UsbHostPlugin instance;

    @Override
    public void load() {
        instance = this;
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter detach = new IntentFilter(UsbManager.ACTION_USB_DEVICE_DETACHED);
        IntentFilter perm = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(detachReceiver, detach, Context.RECEIVER_NOT_EXPORTED);
            // The USB grant is sent by the system. NOT_EXPORTED drops it on Android 14.
            getContext().registerReceiver(permissionReceiver, perm, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(detachReceiver, detach);
            getContext().registerReceiver(permissionReceiver, perm);
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
            getContext().unregisterReceiver(detachReceiver);
        } catch (Exception ignored) {
        }
        try {
            getContext().unregisterReceiver(permissionReceiver);
        } catch (Exception ignored) {
        }
        io.shutdownNow();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray devices = new JSArray();
        if (usbManager != null) {
            for (UsbDevice device : usbManager.getDeviceList().values()) {
                if (isKnownWallet(device)) devices.put(deviceJson(device));
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
                    call.reject(e.getMessage() == null ? "USB open failed" : e.getMessage());
                }
            });
            return;
        }
        call.setKeepAlive(true);
        synchronized (permLock) {
            pendingPermission = call;
            pendingDevice = device;
            pendingMode = requestedMode;
        }
        try {
            // setPackage, not setClass: an explicit component misses the grant on Android 14.
            Intent intent = new Intent(ACTION_USB_PERMISSION);
            intent.setPackage(getContext().getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
            try {
                PendingIntent pi = PendingIntent.getBroadcast(getContext(), device.getDeviceId(), intent, flags);
                usbManager.requestPermission(device, pi);
            } catch (Exception explicitNeeded) {
                Intent fallback = new Intent(getContext(), UsbPermissionReceiver.class);
                fallback.setAction(ACTION_USB_PERMISSION);
                fallback.setPackage(getContext().getPackageName());
                PendingIntent pi = PendingIntent.getBroadcast(getContext(), device.getDeviceId(), fallback, flags);
                usbManager.requestPermission(device, pi);
            }
            startPermissionWatch(device, call);
        } catch (Exception e) {
            synchronized (permLock) {
                if (pendingPermission == call) {
                    pendingPermission = null;
                    pendingDevice = null;
                }
            }
            call.reject(e.getMessage() == null ? "USB permission failed" : e.getMessage());
        }
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
                call.reject(e.getMessage() == null ? "HID write failed" : e.getMessage());
            }
        });
    }

    private JSObject openNow(UsbDevice device, String requestedMode) {
        closeQuietly();
        synchronized (usbLock) {
            connection = usbManager.openDevice(device);
            if (connection == null) throw new IllegalStateException("Could not open USB device");
            openDevice = device;
            mode = requestedMode == null ? "hid" : requestedMode;
            claimedInterface = selectAndClaim(device, mode);
            if (claimedInterface == null) throw new IllegalStateException("No USB interface");
            pickEndpoints(claimedInterface);
            Log.i(TAG, "open vid=" + device.getVendorId()
                + " pid=" + device.getProductId()
                + " iface=" + claimedInterface.getId()
                + " class=" + claimedInterface.getInterfaceClass()
                + " out=" + (hidOut != null)
                + " in=" + (hidIn != null)
                + " mode=" + mode);
            JSObject ret = new JSObject();
            ret.put("device", deviceJson(device));
            ret.put("interfaces", interfacesJson(device));
            ret.put("mode", mode);
            if ("hid".equals(mode)) startHidLoop();
            return ret;
        }
    }

    /**
     * Ledger APDU is the HID interface with usage page 0xFFA0.
     * That is the first HID interface (product-id bit 0). The last HID interface is often FIDO and ignores Bitcoin.
     */
    private UsbInterface selectAndClaim(UsbDevice device, String requestedMode) {
        if ("webusb".equals(requestedMode)) {
            UsbInterface vendor = findInterface(device, 255);
            if (vendor != null && connection.claimInterface(vendor, true)) return vendor;
        }
        List<UsbInterface> hids = new ArrayList<>();
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface intf = device.getInterface(i);
            if (intf.getInterfaceClass() == UsbConstants.USB_CLASS_HID) hids.add(intf);
        }
        for (UsbInterface intf : hids) {
            if (!hasLedgerUsage(intf)) continue;
            if (connection.claimInterface(intf, true)) return intf;
        }
        for (UsbInterface intf : hids) {
            if (!connection.claimInterface(intf, true)) continue;
            if (hasLedgerUsage(intf)) return intf;
            connection.releaseInterface(intf);
        }
        if (!hids.isEmpty() && connection.claimInterface(hids.get(0), true)) return hids.get(0);
        UsbInterface vendor = findInterface(device, 255);
        if (vendor != null && connection.claimInterface(vendor, true)) return vendor;
        if (device.getInterfaceCount() > 0) {
            UsbInterface first = device.getInterface(0);
            if (connection.claimInterface(first, true)) return first;
        }
        return null;
    }

    private boolean hasLedgerUsage(UsbInterface intf) {
        if (connection == null || intf == null) return false;
        byte[] buf = new byte[512];
        int len = connection.controlTransfer(0x81, 0x06, 0x2200, intf.getId(), buf, buf.length, 400);
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

    private void writeHid(int reportId, byte[] payload) throws Exception {
        byte[] data = new byte[64];
        if (payload != null && payload.length > 0) {
            System.arraycopy(payload, 0, data, 0, Math.min(payload.length, 64));
        }
        if (!hidLoop || hidThread == null) {
            synchronized (usbLock) {
                writePacketLocked(reportId, data);
            }
            return;
        }
        CompletableFuture<Void> done = new CompletableFuture<>();
        hidOutQueue.offer(new HidOut(data, reportId, done));
        try {
            done.get(5, TimeUnit.SECONDS);
        } catch (Exception e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            String msg = cause.getMessage();
            throw new IllegalStateException(msg == null || msg.isEmpty() ? "HID write failed" : msg);
        }
    }

    /** Bitcoin app reads the interrupt OUT endpoint. SET_REPORT is only a fallback when that endpoint is missing. */
    private void writePacketLocked(int reportId, byte[] data) {
        if (connection == null) throw new IllegalStateException("USB not open");
        int n = -1;
        if (hidOut != null) n = connection.bulkTransfer(hidOut, data, 64, 2000);
        if (n < 0 && claimedInterface != null) {
            int value = (2 << 8) | (reportId & 0xff);
            int control = connection.controlTransfer(0x21, 0x09, value, claimedInterface.getId(), data, 64, 2000);
            if (control > 0) n = control;
        }
        if (n <= 0) throw new IllegalStateException("HID write failed");
    }

    private void startHidLoop() {
        if (connection == null || hidIn == null) return;
        final UsbDeviceConnection conn = connection;
        final UsbEndpoint inEp = hidIn;
        final UsbRequest request = new UsbRequest();
        if (!request.initialize(conn, inEp)) {
            Log.w(TAG, "UsbRequest.initialize failed");
            return;
        }
        hidRequest = request;
        hidLoop = true;
        hidOutQueue.clear();
        hidThread = new Thread(() -> {
            ByteBuffer buffer = ByteBuffer.allocateDirect(64);
            boolean queued = false;
            try {
                while (hidLoop) {
                    HidOut outgoing = hidOutQueue.poll();
                    if (outgoing != null) {
                        if (queued) {
                            try {
                                request.cancel();
                            } catch (Exception ignored) {
                            }
                            for (int i = 0; i < 4 && hidLoop; i++) {
                                if (reap(conn) != null) break;
                            }
                            queued = false;
                        }
                        try {
                            synchronized (usbLock) {
                                if (!hidLoop || connection == null) throw new IllegalStateException("USB closed");
                                writePacketLocked(outgoing.reportId, outgoing.data);
                            }
                            outgoing.done.complete(null);
                        } catch (Exception e) {
                            outgoing.done.completeExceptionally(e);
                        }
                        continue;
                    }
                    if (!queued) {
                        buffer.clear();
                        synchronized (usbLock) {
                            queued = hidLoop && connection != null && request.queue(buffer, 64);
                        }
                        if (!queued) break;
                    }
                    UsbRequest done = reap(conn);
                    if (!hidLoop) break;
                    if (done == null) continue;
                    queued = false;
                    int reported = buffer.position();
                    buffer.limit(buffer.capacity());
                    buffer.position(0);
                    byte[] raw = new byte[64];
                    buffer.get(raw);
                    int n = reported > 0 ? Math.min(reported, 64) : ((raw[2] & 0xff) == 0x05 ? 64 : 0);
                    if (n <= 0) continue;
                    JSObject ev = new JSObject();
                    ev.put("hex", toHex(raw, n));
                    ev.put("reportId", 0);
                    notifyListeners("hidInput", ev);
                }
            } finally {
                try {
                    request.close();
                } catch (Exception ignored) {
                }
                if (hidRequest == request) hidRequest = null;
                failQueued("USB closed");
            }
        }, "scriptwerk-hid");
        hidThread.setDaemon(true);
        hidThread.start();
    }

    private UsbRequest reap(UsbDeviceConnection conn) {
        try {
            if (Build.VERSION.SDK_INT >= 26) return conn.requestWait(150);
            return conn.requestWait();
        } catch (Exception e) {
            return null;
        }
    }

    private void failQueued(String message) {
        HidOut item;
        while ((item = hidOutQueue.poll()) != null) {
            item.done.completeExceptionally(new IllegalStateException(message));
        }
    }

    private void closeQuietly() {
        Thread t;
        UsbRequest req;
        synchronized (usbLock) {
            hidLoop = false;
            t = hidThread;
            hidThread = null;
            req = hidRequest;
        }
        if (req != null) {
            try {
                req.cancel();
            } catch (Exception ignored) {
            }
        }
        failQueued("USB closed");
        if (t != null && t != Thread.currentThread()) {
            try {
                t.join(800);
            } catch (InterruptedException ignored) {
            }
        }
        synchronized (usbLock) {
            releaseConnectionLocked();
        }
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
        if (device.getVendorId() == 0x03eb && !product.contains("BitBox02")) product = "BitBox02";
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
        if (intent == null) return null;
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
        }
        return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
    }

    private static String toHex(byte[] data, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        int end = Math.min(data.length, len);
        for (int i = 0; i < end; i++) sb.append(String.format(Locale.US, "%02x", data[i] & 0xff));
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

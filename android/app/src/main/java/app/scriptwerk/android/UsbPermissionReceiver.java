package app.scriptwerk.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Manifest receiver. A dynamic one misses the USB grant on Android 14. */
public class UsbPermissionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        UsbHostPlugin.deliverPermission(intent);
    }
}

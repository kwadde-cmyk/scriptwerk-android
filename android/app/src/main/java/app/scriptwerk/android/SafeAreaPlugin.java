package app.scriptwerk.android;

import android.app.Activity;
import android.view.View;
import android.view.ViewTreeObserver;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Publishes the part of the system bars that actually covers the WebView, in CSS pixels.
 * Android WebView before 140 reports env(safe-area-inset-*) as 0, so the page cannot see the
 * status bar or the gesture bar. Capacitor 8.3 does this inside SystemBars; this is that
 * polyfill for Capacitor 6. If the WebView is already laid out below the bars, the overlap is 0
 * and the page does not pad twice.
 */
@CapacitorPlugin(name = "SafeArea")
public class SafeAreaPlugin extends Plugin {
    private ViewTreeObserver.OnGlobalLayoutListener layoutListener;
    private WebView watched;
    private int lastTop = Integer.MIN_VALUE;
    private int lastRight = Integer.MIN_VALUE;
    private int lastBottom = Integer.MIN_VALUE;
    private int lastLeft = Integer.MIN_VALUE;

    @Override
    public void load() {
        attach();
    }

    @Override
    protected void handleOnStart() {
        attach();
    }

    @Override
    protected void handleOnDestroy() {
        detach();
    }

    @PluginMethod
    public void getInsets(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve(empty());
            return;
        }
        activity.runOnUiThread(() -> call.resolve(measure(false)));
    }

    private void attach() {
        Activity activity = getActivity();
        if (activity == null || getBridge() == null || getBridge().getWebView() == null) return;
        activity.runOnUiThread(() -> {
            WebView web = getBridge() != null ? getBridge().getWebView() : null;
            if (web == null) return;
            if (watched != web) {
                detach();
                watched = web;
                layoutListener = () -> measure(true);
                web.getViewTreeObserver().addOnGlobalLayoutListener(layoutListener);
            }
            web.post(() -> measure(true));
        });
    }

    private void detach() {
        WebView web = watched;
        ViewTreeObserver.OnGlobalLayoutListener listener = layoutListener;
        watched = null;
        layoutListener = null;
        if (web == null || listener == null) return;
        ViewTreeObserver observer = web.getViewTreeObserver();
        if (observer.isAlive()) observer.removeOnGlobalLayoutListener(listener);
    }

    private JSObject measure(boolean notify) {
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web == null || web.getWidth() <= 0 || web.getHeight() <= 0) return empty();

        View anchor = web;
        Activity activity = getActivity();
        if (activity != null && activity.getWindow() != null && activity.getWindow().getDecorView() != null) {
            anchor = activity.getWindow().getDecorView();
        }
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(anchor);
        if (insets == null) insets = ViewCompat.getRootWindowInsets(web);
        if (insets == null) return empty();

        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
        Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
        int insetBottom = Math.max(bars.bottom, ime.bottom);

        int[] loc = new int[2];
        web.getLocationInWindow(loc);
        int rootW = anchor.getWidth();
        int rootH = anchor.getHeight();
        if (rootW <= 0 || rootH <= 0) return empty();
        int webLeft = loc[0];
        int webTop = loc[1];
        int webRight = webLeft + web.getWidth();
        int webBottom = webTop + web.getHeight();

        int top = Math.max(0, bars.top - webTop);
        int left = Math.max(0, bars.left - webLeft);
        int right = Math.max(0, webRight - (rootW - bars.right));
        int bottom = Math.max(0, webBottom - (rootH - insetBottom));

        float density = web.getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int cssTop = Math.round(top / density);
        int cssRight = Math.round(right / density);
        int cssBottom = Math.round(bottom / density);
        int cssLeft = Math.round(left / density);

        JSObject ev = insetsJson(cssTop, cssRight, cssBottom, cssLeft);
        if (notify && (cssTop != lastTop || cssRight != lastRight || cssBottom != lastBottom || cssLeft != lastLeft)) {
            lastTop = cssTop;
            lastRight = cssRight;
            lastBottom = cssBottom;
            lastLeft = cssLeft;
            notifyListeners("insets", ev, true);
        }
        return ev;
    }

    private static JSObject insetsJson(int top, int right, int bottom, int left) {
        JSObject o = new JSObject();
        o.put("top", top);
        o.put("right", right);
        o.put("bottom", bottom);
        o.put("left", left);
        return o;
    }

    private static JSObject empty() {
        return insetsJson(0, 0, 0, 0);
    }
}

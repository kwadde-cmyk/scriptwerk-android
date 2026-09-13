package app.scriptwerk.android;

import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.SSLCertificateSocketFactory;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.ConnectException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import javax.net.ssl.SSLException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;

/**
 * Electrum JSON-RPC 1.4 over TLS for StartOS Fulcrum / Electrs.
 * StartOS terminates TLS in front of Fulcrum — LAN has no plaintext port.
 */
@CapacitorPlugin(name = "ElectrumHost")
public class ElectrumHostPlugin extends Plugin {
    private static final String TAG = "ScriptwerkElectrum";

    private volatile String lastIp = "";
    private volatile String lastNet = "";
    private volatile String lastTry = "";
    private volatile String lastDetail = "";

    @PluginMethod
    public void ping(PluginCall call) {
        runAsync(call, () -> pingNow(call));
    }

    @PluginMethod
    public void rpc(PluginCall call) {
        runAsync(call, () -> rpcNow(call));
    }

    private void runAsync(PluginCall call, Job job) {
        Thread t = new Thread(() -> {
            ExecutorService ex = Executors.newSingleThreadExecutor();
            try {
                JSObject ret = ex.submit(job::run).get(18, TimeUnit.SECONDS);
                finishOk(call, ret);
            } catch (TimeoutException e) {
                finishOk(call, failObj("hw.utxo.unreachable", "timeout"));
            } catch (ExecutionException e) {
                Throwable c = e.getCause();
                finishOk(call, failObj(c instanceof Exception ? keyOf((Exception) c) : "hw.utxo.bad", shortErr(c)));
            } catch (Exception e) {
                finishOk(call, failObj(keyOf(e), shortErr(e)));
            } finally {
                ex.shutdownNow();
            }
        }, "scriptwerk-electrum");
        t.start();
    }

    private void finishOk(PluginCall call, JSObject ret) {
        android.app.Activity act = getActivity();
        if (act != null) act.runOnUiThread(() -> call.resolve(ret));
        else call.resolve(ret);
    }

    private interface Job {
        JSObject run() throws Exception;
    }

    private JSObject pingNow(PluginCall call) {
        try {
            Session sess = openSession(call, 8000);
            try {
                int id = 1;
                send(sess.out, id, "server.version", new JSONArray().put("Scriptwerk").put("1.4"), sess.pending);
                sess.out.flush();
                JSONObject msg = readOne(sess, id);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("via", "ElectrumHost");
                ret.put("version", formatVersion(msg.has("result") ? msg.get("result") : ""));
                ret.put("host", sess.ip != null ? sess.ip : sess.host);
                ret.put("port", sess.port);
                ret.put("net", lastNet);
                return ret;
            } finally {
                sess.close();
            }
        } catch (Exception e) {
            return failObj(keyOf(e), lastDetail.isEmpty() ? shortErr(e) : lastDetail);
        }
    }

    private JSObject rpcNow(PluginCall call) throws Exception {
        JSONArray calls = readCalls(call);
        Session sess = openSession(call, 20000);
        try {
            int nextId = 1;
            send(sess.out, nextId++, "server.version", new JSONArray().put("Scriptwerk").put("1.4"), sess.pending);
            JSONArray userIds = new JSONArray();
            for (int i = 0; i < calls.length(); i++) {
                JSONObject job = calls.getJSONObject(i);
                String method = job.optString("method", "");
                JSONArray params = job.optJSONArray("params");
                if (params == null) params = new JSONArray();
                int id = nextId++;
                send(sess.out, id, method, params, sess.pending);
                userIds.put(id);
            }
            sess.out.flush();

            JSONObject[] byId = new JSONObject[nextId];
            int remaining = sess.pending.size();
            long deadline = System.currentTimeMillis() + sess.timeoutMs;
            while (remaining > 0) {
                if (System.currentTimeMillis() > deadline) throw new Exception("hw.utxo.unreachable");
                JSONObject msg = readLine(sess.in);
                if (!msg.has("id") || msg.isNull("id")) continue;
                int id = msg.optInt("id", -1);
                if (!sess.pending.containsKey(id)) continue;
                sess.pending.remove(id);
                remaining--;
                if (msg.has("error") && !msg.isNull("error")) {
                    throw new Exception(errorMessage(msg));
                }
                byId[id] = msg;
            }

            JSONArray results = new JSONArray();
            for (int i = 0; i < userIds.length(); i++) {
                int id = userIds.getInt(i);
                JSONObject msg = byId[id];
                if (msg == null) throw new Exception("hw.utxo.bad");
                results.put(msg.has("result") ? msg.get("result") : JSONObject.NULL);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("results", results);
            return ret;
        } finally {
            sess.close();
        }
    }

    private JSObject failObj(String error, String detail) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        ret.put("via", "ElectrumHost");
        ret.put("error", error == null || error.isEmpty() ? "hw.utxo.unreachable" : error);
        ret.put("detail", detail == null ? "" : detail);
        ret.put("ip", lastIp);
        ret.put("net", lastNet);
        ret.put("attempt", lastTry);
        return ret;
    }

    private Session openSession(PluginCall call, int defaultTimeout) throws Exception {
        String host = String.valueOf(call.getString("host", "")).trim();
        Integer portObj = call.getInt("port");
        int port = portObj == null ? 50001 : portObj;
        boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        String sni = String.valueOf(call.getString("sni", "")).trim();
        if (sni.isEmpty()) sni = host;
        int timeoutMs = call.getInt("timeoutMs") == null ? defaultTimeout : call.getInt("timeoutMs");
        if (timeoutMs < 1000) timeoutMs = defaultTimeout;
        if (host.isEmpty()) throw new Exception("hw.utxo.needElectrum");
        if (isLoopback(host)) throw new Exception("hw.utxo.loopback");
        if (!hostAllowed(host)) throw new Exception(isPublicIndexer(host) ? "hw.utxo.noPublic" : "hw.utxo.lanOnly");
        lastIp = "";
        lastDetail = "";
        lastTry = "";
        Log.i(TAG, "connect " + host + ":" + port + " tls=" + tls + " sni=" + sni);
        int connectMs = Math.min(6000, Math.max(3000, timeoutMs));
        Socket sock;
        try {
            sock = openSocket(host, port, tls, sni, connectMs);
        } catch (Exception e) {
            if (lastBound && lastCm != null) {
                try {
                    lastCm.bindProcessToNetwork(null);
                } catch (Exception ignored) {
                }
                lastBound = false;
            }
            throw e;
        }
        sock.setSoTimeout(timeoutMs);
        Session sess = new Session();
        sess.host = host;
        sess.ip = sock.getInetAddress() != null ? sock.getInetAddress().getHostAddress() : host;
        sess.port = port;
        sess.timeoutMs = timeoutMs;
        sess.sock = sock;
        sess.cm = lastCm;
        sess.bound = lastBound;
        lastBound = false;
        lastCm = null;
        sess.out = new BufferedWriter(new OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8));
        sess.in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
        sess.pending = new HashMap<>();
        return sess;
    }

    private volatile ConnectivityManager lastCm = null;
    private volatile boolean lastBound = false;

    private static JSONArray readCalls(PluginCall call) throws Exception {
        String json = call.getString("callsJson");
        if (json != null && !json.trim().isEmpty()) {
            return new JSONArray(json);
        }
        if (call.getArray("calls") != null) return call.getArray("calls");
        return new JSONArray();
    }

    private static JSONObject readOne(Session sess, int wantId) throws Exception {
        long deadline = System.currentTimeMillis() + sess.timeoutMs;
        while (true) {
            if (System.currentTimeMillis() > deadline) throw new Exception("hw.utxo.unreachable");
            JSONObject msg = readLine(sess.in);
            if (!msg.has("id") || msg.isNull("id")) continue;
            if (msg.optInt("id", -1) != wantId) continue;
            if (msg.has("error") && !msg.isNull("error")) throw new Exception(errorMessage(msg));
            return msg;
        }
    }

    private static JSONObject readLine(BufferedReader in) throws Exception {
        String line = in.readLine();
        if (line == null) throw new Exception("hw.utxo.bad");
        line = line.trim();
        if (line.isEmpty()) return new JSONObject();
        try {
            return new JSONObject(line);
        } catch (Exception e) {
            throw new Exception("hw.utxo.tls");
        }
    }

    private static void send(BufferedWriter out, int id, String method, JSONArray params, Map<Integer, JSONObject> pending) throws Exception {
        JSONObject msg = new JSONObject();
        msg.put("jsonrpc", "2.0");
        msg.put("id", id);
        msg.put("method", method);
        msg.put("params", params);
        pending.put(id, msg);
        out.write(msg.toString());
        out.write("\n");
    }

    @SuppressWarnings("deprecation")
    private Socket openSocket(String host, int port, boolean tls, String sni, int connectMs) throws Exception {
        Network net = pickLanNetwork();
        lastNet = netName(net);
        InetAddress[] ips = resolveAll(net, host, connectMs);
        String sniHost = sniFor(sni, host);
        List<String> errors = new ArrayList<>();
        ConnectivityManager cm = getCm();
        boolean bound = false;
        if (cm != null && net != null) {
            try {
                bound = cm.bindProcessToNetwork(net);
            } catch (Exception ignored) {
            }
        }
        lastCm = cm;
        lastBound = bound;
        try {
            int n = 0;
            for (InetAddress ip : ips) {
                if (ip.isLoopbackAddress() || ip.isAnyLocalAddress()) continue;
                if (n++ >= 2) break;
                lastIp = ip.getHostAddress();
                InetSocketAddress addr = new InetSocketAddress(ip, port);
                Log.i(TAG, "try " + lastIp + ":" + port + " tls=" + tls + " net=" + lastNet + " sni=" + sniHost);
                if (tls) {
                    try {
                        lastTry = "insecure";
                        return connectInsecure(net, addr, sniHost, connectMs);
                    } catch (Exception e) {
                        errors.add(lastIp + " insecure " + shortErr(e));
                        Log.i(TAG, "insecure fail " + shortErr(e));
                    }
                    try {
                        lastTry = "wrap";
                        return connectWrap(net, addr, sniHost, connectMs);
                    } catch (Exception e) {
                        errors.add(lastIp + " wrap " + shortErr(e));
                        Log.i(TAG, "wrap fail " + shortErr(e));
                    }
                } else {
                    try {
                        lastTry = "tcp";
                        return connectPlain(net, addr, connectMs);
                    } catch (Exception e) {
                        errors.add(lastIp + " tcp " + shortErr(e));
                    }
                }
            }
        } catch (Exception e) {
            errors.add(shortErr(e));
            throw e;
        } finally {
            lastDetail = String.join(" | ", errors);
        }
        if (tls) throw new Exception("hw.utxo.tls");
        throw new Exception("hw.utxo.unreachable");
    }

    @SuppressWarnings("deprecation")
    private Socket connectInsecure(Network net, InetSocketAddress addr, String sni, int connectMs) throws Exception {
        SSLCertificateSocketFactory factory =
            (SSLCertificateSocketFactory) SSLCertificateSocketFactory.getInsecure(connectMs, null);
        Socket base = net != null ? net.getSocketFactory().createSocket() : new Socket();
        try {
            base.connect(addr, connectMs);
            String peer = sni.isEmpty() ? "localhost" : sni;
            SSLSocket s = (SSLSocket) factory.createSocket(base, peer, addr.getPort(), true);
            try {
                factory.setHostname(s, peer);
            } catch (Exception ignored) {
            }
            disableEndpointCheck(s);
            s.setUseClientMode(true);
            s.setSoTimeout(connectMs);
            s.startHandshake();
            return s;
        } catch (Exception e) {
            try {
                base.close();
            } catch (Exception ignored) {
            }
            throw e;
        }
    }

    @SuppressWarnings("deprecation")
    private Socket connectWrap(Network net, InetSocketAddress addr, String sni, int connectMs) throws Exception {
        SSLCertificateSocketFactory factory =
            (SSLCertificateSocketFactory) SSLCertificateSocketFactory.getInsecure(connectMs, null);
        SSLSocket s = (SSLSocket) factory.createSocket();
        String peer = sni.isEmpty() ? "localhost" : sni;
        try {
            factory.setHostname(s, peer);
        } catch (Exception ignored) {
        }
        disableEndpointCheck(s);
        s.setUseClientMode(true);
        s.connect(addr, connectMs);
        s.setSoTimeout(connectMs);
        s.startHandshake();
        return s;
    }

    private Socket connectPlain(Network net, InetSocketAddress addr, int connectMs) throws Exception {
        Socket s = net != null ? net.getSocketFactory().createSocket() : new Socket();
        s.connect(addr, connectMs);
        return s;
    }

    private static void disableEndpointCheck(SSLSocket s) {
        try {
            SSLParameters params = s.getSSLParameters();
            params.setEndpointIdentificationAlgorithm(null);
            s.setSSLParameters(params);
        } catch (Exception ignored) {
        }
    }

    private ConnectivityManager getCm() {
        try {
            return (ConnectivityManager) getContext().getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
        } catch (Exception e) {
            return null;
        }
    }

    private Network pickLanNetwork() {
        try {
            ConnectivityManager cm = getCm();
            if (cm == null) return null;
            Network wifi = null;
            Network eth = null;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) eth = n;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi = n;
            }
            if (wifi != null) return wifi;
            if (eth != null) return eth;
            return cm.getActiveNetwork();
        } catch (Exception e) {
            return null;
        }
    }

    private static String netName(Network net) {
        return net == null ? "default" : net.toString();
    }

    private InetAddress[] resolveAll(Network net, String host, int timeoutMs) throws Exception {
        if (host.matches("\\d{1,3}(?:\\.\\d{1,3}){3}")) {
            return new InetAddress[]{InetAddress.getByName(host)};
        }
        ExecutorService ex = Executors.newSingleThreadExecutor();
        try {
            Future<InetAddress[]> f = ex.submit(() -> {
                LinkedHashSet<InetAddress> set = new LinkedHashSet<>();
                try {
                    if (net != null) set.add(net.getByName(host));
                } catch (Exception ignored) {
                }
                try {
                    for (InetAddress a : InetAddress.getAllByName(host)) set.add(a);
                } catch (Exception ignored) {
                }
                List<InetAddress> v4 = new ArrayList<>();
                List<InetAddress> v6 = new ArrayList<>();
                for (InetAddress a : set) {
                    if (a instanceof Inet4Address) v4.add(a);
                    else v6.add(a);
                }
                v4.addAll(v6);
                if (v4.isEmpty()) throw new UnknownHostException(host);
                return v4.toArray(new InetAddress[0]);
            });
            return f.get(Math.min(4000, timeoutMs), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            throw new Exception("hw.utxo.unreachable");
        } catch (ExecutionException e) {
            throw new Exception("hw.utxo.unreachable");
        } finally {
            ex.shutdownNow();
        }
    }

    private static String sniFor(String sni, String host) {
        String h = sni == null || sni.isEmpty() ? host : sni;
        if (h.matches("\\d{1,3}(?:\\.\\d{1,3}){3}")) return "";
        return h;
    }

    private String keyOf(Exception e) {
        String msg = e.getMessage();
        if (msg != null && msg.startsWith("hw.")) return msg.split("[\\s·]")[0];
        if (e instanceof SSLException) return "hw.utxo.tls";
        if (e instanceof UnknownHostException || e instanceof ConnectException) return "hw.utxo.unreachable";
        if ("insecure".equals(lastTry) || "wrap".equals(lastTry) || e instanceof SocketTimeoutException) {
            return "hw.utxo.tls";
        }
        return "hw.utxo.unreachable";
    }

    private static String shortErr(Throwable e) {
        if (e == null) return "";
        String name = e.getClass().getSimpleName();
        String msg = e.getMessage();
        if (msg == null || msg.isEmpty()) return name;
        if (msg.length() > 120) msg = msg.substring(0, 120);
        return name + " " + msg;
    }

    private static String formatVersion(Object result) {
        if (result instanceof JSONArray) {
            JSONArray a = (JSONArray) result;
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < a.length(); i++) {
                String part = a.optString(i, "");
                if (part.isEmpty()) continue;
                if (sb.length() > 0) sb.append(" ");
                sb.append(part);
            }
            return sb.toString();
        }
        return result == null || result == JSONObject.NULL ? "" : String.valueOf(result);
    }

    private static String errorMessage(JSONObject msg) {
        JSONObject err = msg.optJSONObject("error");
        String detail = err != null ? err.optString("message", "") : "";
        return detail.isEmpty() ? "hw.utxo.bad" : detail;
    }

    /** Keep in sync with nativeIndexerHostAllowed() in src/lib/electrum.ts */
    static boolean hostAllowed(String host) {
        String h = normalizeHost(host);
        if (h.isEmpty()) return false;
        if (isPublicIndexer(h) || isLoopback(h)) return false;
        if (h.matches("\\d{1,3}(?:\\.\\d{1,3}){3}")) {
            return h.matches("10(?:\\.\\d{1,3}){3}")
                || h.matches("192\\.168(?:\\.\\d{1,3}){2}")
                || h.matches("172\\.(1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}");
        }
        return true;
    }

    static boolean isLoopback(String host) {
        String h = normalizeHost(host);
        return h.equals("localhost") || h.equals("127.0.0.1") || h.equals("::1") || h.equals("0.0.0.0");
    }

    static boolean isPublicIndexer(String host) {
        String h = normalizeHost(host);
        return h.equals("mempool.space")
            || h.endsWith(".mempool.space")
            || h.equals("blockstream.info")
            || h.endsWith(".blockstream.info");
    }

    private static String normalizeHost(String host) {
        return host.trim().toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
    }

    private static final class Session {
        String host;
        String ip;
        int port;
        int timeoutMs;
        Socket sock;
        ConnectivityManager cm;
        boolean bound;
        BufferedWriter out;
        BufferedReader in;
        Map<Integer, JSONObject> pending;

        void close() {
            try {
                if (sock != null) sock.close();
            } catch (Exception ignored) {
            }
            if (bound && cm != null) {
                try {
                    cm.bindProcessToNetwork(null);
                } catch (Exception ignored) {
                }
            }
        }
    }
}

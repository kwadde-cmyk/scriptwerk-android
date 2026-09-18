package app.scriptwerk.android;

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
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Electrum JSON-RPC 1.4 over TLS (StartOS Fulcrum).
 * PluginCall getters stay on the Capacitor thread — background reads deadlock the WebView.
 */
@CapacitorPlugin(name = "ElectrumHost")
public class ElectrumHostPlugin extends Plugin {
    private static final String TAG = "ScriptwerkElectrum";

    private volatile String lastIp = "";
    private volatile String lastTry = "";
    private volatile String lastDetail = "";
    private volatile String lastCert = "";
    private volatile Socket liveSocket;

    @PluginMethod
    public void ready(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("via", "ElectrumHost");
        ret.put("sdk", android.os.Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void ping(PluginCall call) {
        final String host = String.valueOf(call.getString("host", "")).trim();
        final int port = call.getInt("port") == null ? 50001 : call.getInt("port");
        final boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        String sniArg = String.valueOf(call.getString("sni", "")).trim();
        if (sniArg.isEmpty()) sniArg = host;
        final String sni = sniArg;
        final int timeoutMs = call.getInt("timeoutMs") == null ? 7000 : Math.max(3000, call.getInt("timeoutMs"));
        go(call, () -> pingNow(host, port, tls, sni, timeoutMs), 7000);
    }

    @PluginMethod
    public void rpc(PluginCall call) {
        final String host = String.valueOf(call.getString("host", "")).trim();
        final int port = call.getInt("port") == null ? 50001 : call.getInt("port");
        final boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        String sniArg = String.valueOf(call.getString("sni", "")).trim();
        if (sniArg.isEmpty()) sniArg = host;
        final String sni = sniArg;
        final int timeoutMs = call.getInt("timeoutMs") == null ? 20000 : Math.max(3000, call.getInt("timeoutMs"));
        final String callsJson = call.getString("callsJson");
        JSONArray calls;
        try {
            calls = callsJson != null && !callsJson.trim().isEmpty() ? new JSONArray(callsJson) : new JSONArray();
        } catch (Exception e) {
            call.resolve(failObj("hw.utxo.bad", "callsJson"));
            return;
        }
        final JSONArray jobs = calls;
        go(call, () -> rpcNow(host, port, tls, sni, timeoutMs, jobs), timeoutMs + 2000);
    }

    private interface Job {
        JSObject run() throws Exception;
    }

    private void go(PluginCall call, Job job, long killMs) {
        Thread worker = new Thread(() -> {
            try {
                call.resolve(job.run());
            } catch (Exception e) {
                call.resolve(failObj(keyOf(e), lastDetail.isEmpty() ? shortErr(e) : lastDetail));
            } finally {
                liveSocket = null;
            }
        }, "scriptwerk-electrum");
        worker.start();
        Thread killer = new Thread(() -> {
            try {
                Thread.sleep(Math.max(3000, killMs));
            } catch (InterruptedException ignored) {
                return;
            }
            Socket s = liveSocket;
            if (s != null) {
                Log.i(TAG, "watchdog close " + lastTry + " " + lastDetail);
                try {
                    s.close();
                } catch (Exception ignored) {
                }
            }
        }, "scriptwerk-electrum-kill");
        killer.start();
    }

    private JSObject pingNow(String host, int port, boolean tls, String sni, int timeoutMs) throws Exception {
        lastIp = "";
        lastDetail = "";
        lastCert = "";
        lastTry = tls ? "tls12-tofu" : "tcp";
        Session sess = openSession(host, port, tls, sni, timeoutMs);
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
            ret.put("cert", sess.cert != null ? sess.cert : lastCert);
            ret.put("attempt", lastTry);
            return ret;
        } finally {
            sess.close();
        }
    }

    private JSObject rpcNow(String host, int port, boolean tls, String sni, int timeoutMs, JSONArray calls) throws Exception {
        Session sess = openSession(host, port, tls, sni, timeoutMs);
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
                if (msg.has("error") && !msg.isNull("error")) throw new Exception(errorMessage(msg));
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
        ret.put("attempt", lastTry);
        if (lastCert != null && !lastCert.isEmpty()) ret.put("cert", lastCert);
        return ret;
    }

    private Session openSession(String host, int port, boolean tls, String sni, int timeoutMs) throws Exception {
        if (host.isEmpty()) throw new Exception("hw.utxo.needElectrum");
        if (isLoopback(host)) throw new Exception("hw.utxo.loopback");
        if (!hostAllowed(host)) throw new Exception(isPublicIndexer(host) ? "hw.utxo.noPublic" : "hw.utxo.lanOnly");
        Log.i(TAG, "connect " + host + ":" + port + " tls=" + tls + " sni=" + sni);
        lastTry = tls ? "tls12-tofu" : "tcp";
        int connectMs = Math.min(5000, Math.max(2500, timeoutMs));
        Socket sock = openSocket(host, port, tls, sni, connectMs);
        sock.setSoTimeout(timeoutMs);
        Session sess = new Session();
        sess.host = host;
        sess.ip = sock.getInetAddress() != null ? sock.getInetAddress().getHostAddress() : host;
        sess.port = port;
        sess.timeoutMs = timeoutMs;
        sess.sock = sock;
        sess.cert = lastCert;
        sess.out = new BufferedWriter(new OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8));
        sess.in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
        sess.pending = new HashMap<>();
        return sess;
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

    private Socket openSocket(String host, int port, boolean tls, String sni, int connectMs) throws Exception {
        Socket tcp = connectTcp(host, port, connectMs);
        if (!tls) return tcp;
        lastTry = "tls12-tofu";
        lastDetail = "tcp-ok " + lastIp + " tofu " + sniFor(sni, host);
        return wrapTofu(tcp, sniFor(sni, host), port, connectMs);
    }

    private Socket connectTcp(String host, int port, int connectMs) throws Exception {
        Socket base = new Socket();
        liveSocket = base;
        base.connect(new InetSocketAddress(host, port), connectMs);
        InetAddress ip = base.getInetAddress();
        lastIp = ip != null ? ip.getHostAddress() : host;
        if (ip != null && (ip.isLoopbackAddress() || ip.isAnyLocalAddress())) {
            base.close();
            throw new Exception("hw.utxo.loopback");
        }
        Log.i(TAG, "tcp " + lastIp + ":" + port);
        lastDetail = "tcp-ok " + lastIp + ":" + port;
        return base;
    }

    private SSLSocket wrapTofu(Socket base, String sni, int port, int timeoutMs) throws Exception {
        liveSocket = base;
        CaptureTm tm = new CaptureTm();
        SSLContext ctx;
        try {
            ctx = SSLContext.getInstance("TLSv1.2");
        } catch (Exception e) {
            ctx = SSLContext.getInstance("TLS");
        }
        ctx.init(null, new TrustManager[]{tm}, new SecureRandom());
        String peer = sni == null || sni.isEmpty() ? "localhost" : sni;
        SSLSocket ssl = (SSLSocket) ctx.getSocketFactory().createSocket(base, peer, port, true);
        liveSocket = ssl;
        setSni(ssl, peer);
        try {
            ssl.setEnabledProtocols(new String[]{"TLSv1.2"});
        } catch (Exception ignored) {
        }
        ssl.setUseClientMode(true);
        ssl.setSoTimeout(timeoutMs);
        lastDetail = "tcp-ok " + lastIp + " tls12 sni=" + peer;
        ssl.startHandshake();
        lastCert = certInfo(tm.chain, ssl);
        lastDetail = "tls12-tofu " + lastIp + " " + lastCert;
        Log.i(TAG, lastDetail);
        return ssl;
    }

    private static void setSni(SSLSocket ssl, String peer) {
        try {
            ssl.getClass().getMethod("setHostname", String.class).invoke(ssl, peer);
        } catch (Exception ignored) {
        }
        try {
            SSLParameters params = ssl.getSSLParameters();
            params.setEndpointIdentificationAlgorithm(null);
            ssl.setSSLParameters(params);
        } catch (Exception ignored) {
        }
    }

    private static String sniFor(String sni, String host) {
        String h = sni == null || sni.isEmpty() ? host : sni;
        if (h.matches("\\d{1,3}(?:\\.\\d{1,3}){3}")) return "";
        return h;
    }

    private static String certInfo(X509Certificate[] chain, SSLSocket ssl) {
        try {
            X509Certificate leaf = null;
            if (chain != null && chain.length > 0) leaf = chain[0];
            if (leaf == null) {
                SSLSession ses = ssl.getSession();
                if (ses != null && ses.getPeerCertificates() != null && ses.getPeerCertificates().length > 0
                    && ses.getPeerCertificates()[0] instanceof X509Certificate) {
                    leaf = (X509Certificate) ses.getPeerCertificates()[0];
                }
            }
            if (leaf == null) return "";
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(leaf.getEncoded());
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < d.length; i++) {
                if (i > 0 && i % 2 == 0) hex.append(":");
                hex.append(String.format(Locale.US, "%02x", d[i]));
            }
            String cn = leaf.getSubjectDN() != null ? leaf.getSubjectDN().getName() : "";
            return hex + (cn.isEmpty() ? "" : " " + cn);
        } catch (Exception e) {
            return "";
        }
    }

    private String keyOf(Exception e) {
        String msg = e.getMessage();
        if (msg != null && msg.startsWith("hw.")) return msg.split("[\\s·]")[0];
        if (e instanceof SSLException) return "hw.utxo.tls";
        if (e instanceof UnknownHostException || e instanceof ConnectException) return "hw.utxo.unreachable";
        if (lastTry != null && lastTry.startsWith("tls")) return "hw.utxo.tls";
        if (e instanceof SocketTimeoutException) return "hw.utxo.tls";
        return "hw.utxo.unreachable";
    }

    private static String shortErr(Throwable e) {
        if (e == null) return "";
        String name = e.getClass().getSimpleName();
        String msg = e.getMessage();
        if (msg == null || msg.isEmpty()) return name;
        if (msg.length() > 140) msg = msg.substring(0, 140);
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

    private static final class CaptureTm implements X509TrustManager {
        volatile X509Certificate[] chain = new X509Certificate[0];

        public void checkClientTrusted(X509Certificate[] c, String a) { chain = c; }
        public void checkServerTrusted(X509Certificate[] c, String a) { chain = c; }
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    private static final class Session {
        String host;
        String ip;
        String cert;
        int port;
        int timeoutMs;
        Socket sock;
        BufferedWriter out;
        BufferedReader in;
        Map<Integer, JSONObject> pending;

        void close() {
            try {
                if (sock != null) sock.close();
            } catch (Exception ignored) {
            }
        }
    }
}

#!/usr/bin/env node
/**
 * Build a sideloadable debug APK with Capacitor + the Android SDK.
 * Output: /workspace/artifacts/Scriptwerk.apk
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = "/workspace";
const javaHome = "/usr/lib/jvm/java-17-openjdk-amd64";
const androidHome = process.env.ANDROID_HOME || "/tmp/android-sdk";
const outApk = join(root, "artifacts", "Scriptwerk.apk");

function env() {
  return {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    PATH: `${javaHome}/bin:${androidHome}/cmdline-tools/latest/bin:${androidHome}/platform-tools:${androidHome}/build-tools/34.0.0:${process.env.PATH}`,
  };
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: opts.cwd || root, stdio: "inherit", env: env(), ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function findWebDir() {
  const candidates = [
    join(root, "dist/client"),
    join(root, "dist/public"),
    join(root, ".output/public"),
    join(root, "dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html")) || existsSync(join(dir, "_shell.html"))) return dir;
  }
  return null;
}

function ensureIndexHtml(webDir) {
  const index = join(webDir, "index.html");
  const shell = join(webDir, "_shell.html");
  if (existsSync(shell)) copyFileSync(shell, index);
  if (!existsSync(index)) {
    console.error("[apk] no index.html in", webDir);
    process.exit(1);
  }
}

function patchAndroidManifest() {
  const manifestPath = join(root, "android/app/src/main/AndroidManifest.xml");
  if (!existsSync(manifestPath)) return;
  let xml = readFileSync(manifestPath, "utf8");
  const extras = [
    '    <uses-permission android:name="android.permission.CAMERA" />',
    '    <uses-permission android:name="android.permission.INTERNET" />',
    '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    '    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />',
    '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
    '    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
    '    <uses-feature android:name="android.hardware.usb.host" android:required="false" />',
  ];
  const missing = extras.filter((line) => {
    const name = /android:name="([^"]+)"/.exec(line)?.[1];
    return Boolean(name) && !xml.includes(`android:name="${name}"`);
  });
  if (missing.length) {
    if (!xml.includes("<manifest")) {
      console.error("[apk] AndroidManifest.xml has no <manifest> tag");
      process.exit(1);
    }
    xml = xml.replace(/(<manifest\b[^>]*>)/, `$1\n${missing.join("\n")}\n`);
  }
  xml = xml.replace(
    /android:usesCleartextTraffic="false"/,
    'android:usesCleartextTraffic="true"',
  );
  if (!xml.includes("usesCleartextTraffic")) {
    xml = xml.replace(
      /<application\b/,
      '<application\n        android:usesCleartextTraffic="true"',
    );
  }
  if (!xml.includes("networkSecurityConfig")) {
    xml = xml.replace(
      /<application\b/,
      '<application\n        android:networkSecurityConfig="@xml/network_security_config"',
    );
  }
  if (!xml.includes("android.hardware.usb.action.USB_DEVICE_ATTACHED")) {
    xml = xml.replace(
      "</intent-filter>",
      `</intent-filter>
            <intent-filter>
                <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
            </intent-filter>
            <meta-data
                android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
                android:resource="@xml/device_filter" />`,
    );
  }
  writeFileSync(manifestPath, xml);
  const xmlDir = join(root, "android/app/src/main/res/xml");
  mkdirSync(xmlDir, { recursive: true });
  writeFileSync(
    join(xmlDir, "device_filter.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <usb-device vendor-id="11415" />
    <usb-device vendor-id="1003" />
    <usb-device vendor-id="4617" />
</resources>
`,
  );
  // Keep the committed network_security_config (cleartext only localhost/*.local).
}

function verifyApk() {
  const aapt = join(androidHome, "build-tools/34.0.0/aapt");
  if (!existsSync(aapt)) {
    console.warn("[apk] aapt missing, skip permission check");
    return;
  }
  const r = spawnSync(aapt, ["dump", "permissions", outApk], { encoding: "utf8", env: env() });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (!out.includes("android.permission.CAMERA")) {
    console.error("[apk] CAMERA permission missing from packaged APK\n", out);
    process.exit(1);
  }
  const listed = spawnSync("unzip", ["-l", outApk], { encoding: "utf8" });
  const files = listed.stdout ?? "";
  if (!files.includes("index.html")) {
    console.error("[apk] index.html missing from packaged APK");
    process.exit(1);
  }
  const dex = spawnSync(
    "python3",
    [
      "-c",
      "import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nprint(any(n.endswith('.dex') and b'ElectrumHost' in z.read(n) for n in z.namelist()))",
      outApk,
    ],
    { encoding: "utf8", env: env() },
  );
  if (!String(dex.stdout ?? "").includes("True")) {
    console.error("[apk] ElectrumHost plugin missing from DEX");
    process.exit(1);
  }
  console.log("[apk] CAMERA + Electrum TCP + index.html present");
}

function writeAndroidReadme() {
  writeFileSync(
    join(root, "android/README.md"),
    `# Scriptwerk Android APK

Sideloadbare Debug-APK: \`artifacts/Scriptwerk.apk\` (Paket \`app.scriptwerk.android\`).

## Installieren

1. Datei aufs Telefon kopieren.
2. Einstellungen → Sicherheit → **Unbekannte Apps installieren** für den verwendeten Dateimanager/Browser erlauben.
3. APK antippen. Play Protect kann warnen — das ist eine Debug-Signatur, kein Play-Store-Build.

## Kamera

Die APK hat \`CAMERA\`. Beim ersten Scan fragt Android nach der Kamera. Live-QR und der Button **Foto** nutzen die Gerätekamera.

## USB / Hardware-Wallets

Die APK spricht Ledger und BitBox02 **nativ** über USB-Host. Gerät einstecken, USB-Zugriff erlauben. Ledger: Bitcoin-App offen, Ledger Live zu. BitBox: entsperren.

## Bitcoin Core (kein Node-Tab)

Die App spricht Core **direkt** über HTTP — ohne Brücke, ohne Lesezeichen. LAN-IP eintragen (nicht 127.0.0.1), z. B. \`http://192.168.1.20:8332\`.

## Indexer (Fulcrum / Electrs)

UTXOs kommen **nicht** von mempool.space. Im Node-Dialog **Fulcrum oder Electrs** im Heimnetz eintragen, z. B. \`192.168.1.20:50001\` oder \`ssl://fulcrum.local:50002\`. Beim **Verbinden** schickt die App \`server.version\` per Electrum-TCP — im Fulcrum-Log muss eine Session erscheinen.

\`127.0.0.1\` ist das Telefon, nicht der Node. \`.local\` oft ohne mDNS — LAN-IP nutzen.

`,
  );
}

const publicApk = join(root, "public", "Scriptwerk.apk");
if (existsSync(publicApk)) rmSync(publicApk);

run("npx", ["vite", "build", "--config", "vite.apk.config.ts"]);

const webDir = findWebDir();
if (!webDir) {
  console.error("[apk] SPA build produced no web directory");
  process.exit(1);
}
ensureIndexHtml(webDir);
console.log("[apk] webDir", webDir);

if (!existsSync(join(root, "android/app/build.gradle"))) {
  if (existsSync(join(root, "android"))) {
    const names = readdirSync(join(root, "android"));
    if (names.every((n) => n === "README.md" || n === ".gitkeep")) {
      rmSync(join(root, "android"), { recursive: true, force: true });
    }
  }
  run("npx", ["cap", "add", "android"]);
}

run("npx", ["cap", "sync", "android"]);
patchAndroidManifest();
writeAndroidReadme();

writeFileSync(join(root, "android/local.properties"), `sdk.dir=${androidHome}\n`);

const gradle = join(root, "android/gradlew");
run(gradle, ["assembleDebug", "--no-daemon"], { cwd: join(root, "android") });

const debugApk = join(root, "android/app/build/outputs/apk/debug/app-debug.apk");
if (!existsSync(debugApk)) {
  console.error("[apk] gradle finished but app-debug.apk is missing");
  process.exit(1);
}
mkdirSync(join(root, "artifacts"), { recursive: true });
copyFileSync(debugApk, outApk);
copyFileSync(debugApk, publicApk);
verifyApk();
const mb = (statSync(outApk).size / (1024 * 1024)).toFixed(1);
console.log(`[apk] wrote ${outApk} and ${publicApk} (${mb} MB)`);

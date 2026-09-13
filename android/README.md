# Scriptwerk Android APK

Sideload debug APK: `artifacts/Scriptwerk.apk` (package `app.scriptwerk.android`).

## Install

1. Copy the APK to the phone.
2. Settings → Security → allow **Install unknown apps** for the file manager/browser.
3. Open the APK. Play Protect may warn — debug signature, not Play Store.

## Camera

The APK has `CAMERA`. First scan asks for permission. Live QR and **Foto** use the device camera.

## USB / hardware wallets

Ledger and BitBox02 over USB-OTG. Plug in, allow USB access. Ledger: Bitcoin app open, Ledger Live closed. BitBox: unlocked.

## Bitcoin Core (no node-tab bridge)

The app talks to Core over HTTP from the phone. Enter the LAN / `.local` URL from StartOS Interfaces, not `127.0.0.1`. Example: `https://capable-dosage.local:8332` (port from Interfaces).

## Fulcrum / Electrs

UTXOs do **not** come from mempool.space. In the node dialog paste the **Electrum (SSL)** address from StartOS, e.g. `ssl://capable-dosage.local:64718`. Keep `ssl://` and that port — StartOS only exposes TLS on the LAN.

On **Verbinden** the app sends `server.version` over Electrum TLS (Wi-Fi, SNI, trust the StartOS cert). Fulcrum logs a session only after the handshake completes.

`127.0.0.1` is the phone. Same Wi-Fi as the node.

# Scriptwerk Android

Native Android port of [scriptwerk-startos](https://github.com/kwadde-cmyk/scriptwerk-startos) — a Bitcoin miniscript studio as a sideloadable APK (`app.scriptwerk.android`).

Not a PWA. Camera and USB (Ledger / BitBox02) run through native Capacitor plugins. Bitcoin Core is spoken over HTTPS from the phone. UTXOs come from **your** Fulcrum or Electrs on the LAN — never a public indexer.

## What this is

Scriptwerk is **not a wallet**. It designs and checks miniscript policies (stages, keys, descriptors, checksums). You verify them on Bitcoin Core and on the device before coins sit on them.

- Stages, Tree, Keys, Descriptor (+ Expert)
- Camera QR import
- Native USB-OTG for Ledger and BitBox02
- Bitcoin Core RPC from the phone (no desktop bookmarklet)
- Fulcrum / Electrs Electrum TCP/TLS for UTXOs (StartOS `ssl://host:port` from Interfaces)

English and German.

## Install the APK

1. Download `Scriptwerk.apk` from [Releases](https://github.com/kwadde-cmyk/scriptwerk-android/releases).
2. Allow install from that source (unknown apps).
3. Play Protect will warn — this is a **debug-signed** sideload, not Play Store.

USB-OTG is required for hardware wallets. Debug signature is expected.

## Node + Fulcrum (StartOS)

Paste the addresses from StartOS **Interfaces**:

- Core: `https://your-box.local:<rpc-port>` with the RPC user from Bitcoin → Actions
- Fulcrum: `ssl://your-box.local:<electrum-port>` — keep `ssl://` and that port. StartOS terminates TLS in front of Fulcrum; there is no plaintext LAN port.

`127.0.0.1` is the phone, not the node. The phone must be on the same Wi-Fi as the box.

On connect the app sends Electrum `server.version`. Fulcrum only logs a client session **after** the TLS handshake. Mempool-sync lines (`<SynchMempool>`, `<Controller>`) are not wallet connections.

## Build

```bash
npm install
npm run build:apk
```

Output: `artifacts/Scriptwerk.apk`. Needs JDK 17 and Android SDK 34.

## Upstream

Policy compiler, BIP-388, Bitcoin Core / Electrum: [kwadde-cmyk/scriptwerk-startos](https://github.com/kwadde-cmyk/scriptwerk-startos).

## Notice

A tool to design and check policies. Not a wallet, not a mainnet signer without your own review. Verify descriptor and checksum on Bitcoin Core and on the device before coins sit on it.

@teh_jenz on X

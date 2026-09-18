# Scriptwerk Android APK

Sideloadbare Debug-APK: `artifacts/Scriptwerk.apk` (Paket `app.scriptwerk.android`).

## Installieren

1. Datei aufs Telefon kopieren.
2. Einstellungen → Sicherheit → **Unbekannte Apps installieren** für den verwendeten Dateimanager/Browser erlauben.
3. APK antippen. Play Protect kann warnen — das ist eine Debug-Signatur, kein Play-Store-Build.

## Kamera

Die APK hat `CAMERA`. Beim ersten Scan fragt Android nach der Kamera. Live-QR und der Button **Foto** nutzen die Gerätekamera.

## USB / Hardware-Wallets

Die APK spricht Ledger und BitBox02 **nativ** über USB-Host. Gerät einstecken, USB-Zugriff erlauben. Ledger: Bitcoin-App offen, Ledger Live zu. BitBox: entsperren.

## Bitcoin Core (kein Node-Tab)

Die App spricht Core **direkt** über HTTP — ohne Brücke, ohne Lesezeichen. LAN-IP eintragen (nicht 127.0.0.1), z. B. `http://192.168.1.20:8332`.

## Indexer (Fulcrum / Electrs)

UTXOs kommen **nicht** von mempool.space. Im Node-Dialog **Fulcrum oder Electrs** im Heimnetz eintragen, z. B. `192.168.1.20:50001` oder `ssl://fulcrum.local:50002`. Beim **Verbinden** schickt die App `server.version` per Electrum-TCP — im Fulcrum-Log muss eine Session erscheinen.

`127.0.0.1` ist das Telefon, nicht der Node. `.local` oft ohne mDNS — LAN-IP nutzen.


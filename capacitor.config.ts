import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.scriptwerk.android",
  appName: "Scriptwerk",
  webDir: "dist/client",
  android: {
    allowMixedContent: true,
    backgroundColor: "#0b0c0e",
    webContentsDebuggingEnabled: true,
  },
  server: {
    androidScheme: "https",
    cleartext: true,
  },
  plugins: {
    CapacitorCookies: {
      enabled: true,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0b0c0e",
    },
  },
};

export default config;

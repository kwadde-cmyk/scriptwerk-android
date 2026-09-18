import type { DiagReport } from "./diagnose.ts";
import { splitCookie } from "./rpc.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

let target: Window | null = null;
let targetOrigin = "";
let auth = { user: "", pass: "" };
const pending = new Map<number, Pending>();
let seq = 1;
let lastHttp = "";

export function corsBlocked(report: DiagReport): boolean {
  const reachOk = report.steps.some((s) => s.id === "reach" && s.status === "ok");
  const rpcFail = report.steps.some((s) => s.id === "rpc" && s.status === "fail");
  const corsFail = report.steps.some(
    (s) => (s.id === "corsGet" || s.id === "preflight") && (s.status === "fail" || s.status === "skip"),
  );
  return reachOk && rpcFail && corsFail;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function isBridgeOn(): boolean {
  return Boolean(target && !target.closed);
}

export function lastBridgeHttp(): string {
  return lastHttp;
}

export function dropBridge(): void {
  target = null;
  targetOrigin = "";
  auth = { user: "", pass: "" };
  lastHttp = "";
  for (const p of pending.values()) p.reject(new Error("node.err.bridgeGone"));
  pending.clear();
}

export function setBridgeAuth(user: string, pass: string): void {
  const a = splitCookie(user, pass);
  auth = { user: a.username, pass: a.password };
}

export function rpcViaBridge(
  method: string,
  params: unknown[] = [],
  creds?: { user: string; pass: string },
): Promise<unknown> {
  if (creds) setBridgeAuth(creds.user, creds.pass);
  if (!target || target.closed) return Promise.reject(new Error("node.err.bridgeGone"));
  const id = seq++;
  const win = target;
  const dest = targetOrigin;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("node.err.unreachable"));
    }, 20000);
    pending.set(id, {
      resolve: (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    });
    win.postMessage({ type: "scriptwerk-rpc", id, method, params, auth }, dest);
  });
}

export function bridgeScript(parentOrigin: string): string {
  return `(function(){
var P=${JSON.stringify(parentOrigin)};
var rpc=location.origin+"/";
var auth=null;
function parentWin(){return window.opener&&window.opener!==window?window.opener:(window.parent&&window.parent!==window?window.parent:null);}
function go(d){var w=parentWin();if(!w)return;try{w.postMessage(d,"*");}catch(e){}}
function fromParent(e){
  if(!e||!e.data)return false;
  var w=parentWin();
  if(w&&e.source===w)return true;
  if(e.origin===P)return true;
  return false;
}
function paint(extra){
  document.title="Scriptwerk-Bruecke";
  document.body.setAttribute("style","font-family:system-ui,sans-serif;background:#0b0c0e;color:#e8e6e3;padding:32px;max-width:36rem;line-height:1.45");
  document.body.innerHTML="<h1 style=\\"font-size:1.35rem;margin:0 0 12px\\">Scriptwerk-Brücke aktiv</h1><p>Diesen Tab offen lassen und zu Scriptwerk zurückgehen.</p><p style=\\"color:#9a9590\\">bitcoind spricht nur POST. GET-Meldung im Tab ist normal.</p><pre id=swlog style=\\"white-space:pre-wrap;color:#7d9b96;font-size:12px;margin-top:16px\\"></pre>";
  if(extra){var el=document.getElementById("swlog");if(el)el.textContent=extra;}
}
function b64(s){
  try{
    var bytes=typeof TextEncoder!=="undefined"?new TextEncoder().encode(s):null;
    if(bytes){var bin="";for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);return btoa(bin);}
    return btoa(s);
  }catch(e){
    return btoa(unescape(encodeURIComponent(s)));
  }
}
function headers(){
  var h={"Content-Type":"text/plain","Accept":"application/json"};
  if(auth&&(auth.user||auth.pass))h.Authorization="Basic "+b64(String(auth.user||"").trim()+":"+String(auth.pass||"").trim());
  return h;
}
function who(){
  var u=auth&&auth.user?String(auth.user).trim():"";
  var n=auth&&auth.pass?String(auth.pass).length:0;
  return (u||"(kein Nutzer)")+" · Passwort "+n+" Zeichen";
}
function post(method,params,id){
  var body=JSON.stringify({jsonrpc:"1.0",id:id,method:String(method||""),params:params||[]});
  return fetch(rpc,{method:"POST",headers:headers(),body:body,credentials:"omit",cache:"no-store",mode:"same-origin"})
    .then(function(r){return r.text().then(function(t){return {status:r.status,text:t};});})
    .catch(function(e){
      var h2={"Content-Type":"application/json"};
      if(auth&&(auth.user||auth.pass))h2.Authorization="Basic "+b64(String(auth.user||"").trim()+":"+String(auth.pass||"").trim());
      return fetch(rpc,{method:"POST",headers:h2,body:body,credentials:"omit",cache:"no-store"})
        .then(function(r){return r.text().then(function(t){return {status:r.status,text:t};});});
    });
}
function packErr(pack){
  var raw=(pack.text||"").replace(/\\s+/g," ").slice(0,180);
  if(pack.status===401||pack.status===403) return "node.err.auth · HTTP "+pack.status+" · "+who()+(raw?" · "+raw:"");
  try{
    var j=JSON.parse(pack.text||"");
    if(j&&j.error&&j.error.message) return "HTTP "+pack.status+" · "+j.error.message;
  }catch(e){}
  return "HTTP "+pack.status+" · "+(raw||"leerer Body");
}
function sendResult(id,pack){
  var json=null;
  try{json=pack.text?JSON.parse(pack.text):null;}catch(e){}
  var err=null;
  if(!json) err=packErr(pack);
  else if(pack.status===401||pack.status===403) err="node.err.auth";
  else if(json.error&&json.error.message) err=json.error.message;
  else if(pack.status>=400 && json.result==null) err=packErr(pack);
  go({type:"scriptwerk-rpc-result",id:id,json:json,error:err,http:pack.status,raw:(pack.text||"").slice(0,240)});
}
window.addEventListener("message",function(e){
  if(!fromParent(e))return;
  P=e.origin||P;
  if(e.data.type==="scriptwerk-hello"){
    auth=e.data.auth||auth;
    post("getnetworkinfo",[], "hello").then(function(pack){
      paint("Selbsttest getnetworkinfo → HTTP "+pack.status+"\\n"+who()+"\\n"+(pack.text||"").slice(0,240));
      go({type:"scriptwerk-bridge-probe",http:pack.status,text:(pack.text||"").slice(0,400)});
      sendResult("hello",pack);
    }).catch(function(err){
      paint(String(err));
      go({type:"scriptwerk-bridge-probe",error:String(err)});
    });
    return;
  }
  if(e.data.type!=="scriptwerk-rpc")return;
  if(e.data.auth) auth=e.data.auth;
  post(e.data.method,e.data.params,e.data.id).then(function(pack){
    paint("RPC "+e.data.method+" → HTTP "+pack.status+"\\n"+who()+"\\n"+(pack.text||"").slice(0,240));
    sendResult(e.data.id,pack);
  }).catch(function(err){
    paint(String(err));
    go({type:"scriptwerk-rpc-result",id:e.data.id,error:String(err)});
  });
});
paint("");
go({type:"scriptwerk-bridge-ready",origin:location.origin});
})();`.replace(/\n/g, "");
}

export function bookmarkletHref(parentOrigin: string): string {
  const src = bridgeScript(parentOrigin);
  return `javascript:void ${src}`;
}

export function openNodeTab(url: string): Window | null {
  return window.open(url, "scriptwerk-node");
}

let onReadyCb: () => void = () => {};
let listening = false;

export function watchBridge(
  expectedOrigin: string,
  creds: { user: string; pass: string },
  onReady: () => void,
): () => void {
  targetOrigin = expectedOrigin;
  setBridgeAuth(creds.user, creds.pass);
  onReadyCb = onReady;
  if (listening) return () => {};
  listening = true;
  const onMsg = (e: MessageEvent) => {
    if (e.origin !== targetOrigin) return;
    const data = e.data as {
      type?: string;
      id?: number | string;
      json?: { result?: unknown; error?: { message?: string } };
      error?: string;
      http?: number;
      raw?: string;
      text?: string;
    } | null;
    if (!data || typeof data !== "object") return;
    if (data.type === "scriptwerk-bridge-ready" && e.source) {
      target = e.source as Window;
      target.postMessage({ type: "scriptwerk-hello", auth }, targetOrigin);
      onReadyCb();
      return;
    }
    if (data.type === "scriptwerk-bridge-probe") {
      lastHttp = data.error
        ? String(data.error)
        : `HTTP ${data.http ?? "?"} ${(data.text || "").replace(/\s+/g, " ").slice(0, 180)}`;
      return;
    }
    if (data.type !== "scriptwerk-rpc-result" || data.id == null || data.id === "hello") return;
    const wait = pending.get(Number(data.id));
    if (!wait) return;
    pending.delete(Number(data.id));
    if (data.http != null || data.raw) {
      lastHttp = `HTTP ${data.http ?? "?"} ${(data.raw || data.error || "").replace(/\s+/g, " ").slice(0, 180)}`;
    }
    if (data.error) wait.reject(new Error(data.error));
    else if (data.json?.error?.message) wait.reject(new Error(data.json.error.message));
    else wait.resolve(data.json?.result);
  };
  window.addEventListener("message", onMsg);
  return () => {};
}

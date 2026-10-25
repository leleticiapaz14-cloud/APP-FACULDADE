import { savePushSubscription, deletePushSubscription } from "./db.js";

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// "unsupported" | "needs-install" | "no-key" | "denied" | "on" | "off"
export async function pushState() {
  if (!VAPID) return "no-key";
  if (isIOS() && !isStandalone()) return "needs-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

const b64ToBytes = b64 => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Você não permitiu as notificações.");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID) });
  const j = sub.toJSON();
  await savePushSubscription({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await deletePushSubscription(sub.endpoint);
  await sub.unsubscribe();
}

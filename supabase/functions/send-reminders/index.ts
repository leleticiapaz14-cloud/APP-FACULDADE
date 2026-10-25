// Edge Function chamada pelo pg_cron a cada 15 minutos. Decide quais avisos mandar
// para cada pessoa (prova chegando, meta de estudo, "você foi na aula?") e envia por Web Push.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const APP_URL = (Deno.env.get("APP_URL") || "").replace(/\/$/, "");

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:meu-semestre@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Msg = { key: string; title: string; body: string; url?: string; tag?: string; actions?: { action: string; title: string }[]; actionUrls?: Record<string, string> };

// Data e hora locais no fuso da pessoa
function local(now: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now).map(x => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day, h = +p.hour, mi = +p.minute, s = +p.second;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const offset = Date.UTC(y, m - 1, d, h, mi, s) - Math.floor(now.getTime() / 1000) * 1000;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { y, m, d, h, mi, wd, date, minutes: h * 60 + mi, offset };
}
const isoUTC = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDaysIso = (iso: string, n: number) => { const [y, m, d] = iso.split("-").map(Number); return isoUTC(Date.UTC(y, m - 1, d + n)); };
const hm = (t: string | null) => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fmtMin = (min: number) => { const m = Math.round(min), h = Math.floor(m / 60), r = m % 60; return h && r ? `${h}h${String(r).padStart(2, "0")}` : h ? `${h}h` : `${r}min`; };
const TYPE = { prova: "Prova", trabalho: "Trabalho", seminario: "Seminário" } as Record<string, string>;

async function messagesFor(profile: any, now: Date): Promise<Msg[]> {
  const L = local(now, profile.timezone || "America/Sao_Paulo");
  const out: Msg[] = [];
  const inSemester = (!profile.semester_start || L.date >= profile.semester_start) && (!profile.semester_end || L.date <= profile.semester_end);
  const awake = L.h >= 8 && L.h < 22;

  const { data: subjects } = await db.from("subjects").select("id, name, days, start_time, end_time, weekly_goal_minutes").eq("user_id", profile.id);
  if (!subjects?.length) return out;
  const byId = new Map(subjects.map(s => [s.id, s]));

  // 1) Provas e trabalhos: 3 dias antes, 1 dia antes e no dia, a partir das 8h
  if (profile.notify_events && awake) {
    const { data: events } = await db.from("events").select("id, subject_id, event_date, type, title")
      .eq("user_id", profile.id).gte("event_date", L.date).lte("event_date", addDaysIso(L.date, 3));
    for (const e of events || []) {
      const n = Math.round((Date.parse(e.event_date) - Date.parse(L.date)) / 86400000);
      if (![0, 1, 3].includes(n)) continue;
      const s = byId.get(e.subject_id);
      const when = n === 0 ? "é hoje" : n === 1 ? "é amanhã" : "é daqui a 3 dias";
      out.push({
        key: `evento:${e.id}:${n}`, tag: `evento-${e.id}`, url: "/?aba=calendario",
        title: `${TYPE[e.type] || "Evento"} ${when}`,
        body: `${e.title}${s ? ` (${s.name})` : ""}`,
      });
    }
  }

  // 2) Meta de estudo: sexta às 18h e domingo às 15h, se alguma matéria estiver atrasada
  const slot = L.wd === 5 && L.h >= 18 ? "sex" : L.wd === 0 && L.h >= 15 ? "dom" : null;
  if (profile.notify_study && inSemester && slot && L.h < 22) {
    const mondayIso = addDaysIso(L.date, -((L.wd + 6) % 7));
    const [my, mm, md] = mondayIso.split("-").map(Number);
    const from = new Date(Date.UTC(my, mm - 1, md) - L.offset).toISOString();
    const { data: sessions } = await db.from("study_sessions").select("subject_id, minutes").eq("user_id", profile.id).gte("started_at", from);
    const done = new Map<string, number>();
    for (const x of sessions || []) done.set(x.subject_id, (done.get(x.subject_id) || 0) + x.minutes);
    const behind = subjects.filter(s => s.weekly_goal_minutes > 0)
      .map(s => ({ s, gap: s.weekly_goal_minutes - (done.get(s.id) || 0) }))
      .filter(x => x.gap > 0).sort((a, b) => b.gap - a.gap);
    if (behind.length) {
      const [top, ...rest] = behind;
      out.push({
        key: `estudo:${mondayIso}:${slot}`, tag: "estudo", url: "/?aba=estudo",
        title: slot === "dom" ? "A semana está acabando" : "Chegou o fim de semana",
        body: `Faltam ${fmtMin(top.gap)} de ${top.s.name} para bater sua meta${rest.length ? ` (e mais ${rest.length} ${rest.length === 1 ? "matéria" : "matérias"})` : ""}. Que tal começar agora?`,
      });
    }
  }

  // 3) "Você foi na aula?": do fim da aula até 3h depois, se ainda não registrou
  if (profile.notify_classes && inSemester) {
    const todays = subjects.filter(s => (s.days || []).includes(L.wd) && hm(s.end_time) != null && L.minutes >= hm(s.end_time)! && L.minutes < hm(s.end_time)! + 180);
    if (todays.length) {
      const { data: rows } = await db.from("attendance").select("subject_id").eq("user_id", profile.id).eq("class_date", L.date);
      const marked = new Set((rows || []).map(r => r.subject_id));
      for (const s of todays) {
        if (marked.has(s.id)) continue;
        const base = `/?registrar=${s.id}&data=${L.date}`;
        out.push({
          key: `aula:${s.id}:${L.date}`, tag: `aula-${s.id}`, url: base,
          title: `Você foi na aula de ${s.name}?`, body: "Toque para registrar a presença.",
          actions: [{ action: "fui", title: "Fui" }, { action: "faltei", title: "Faltei" }],
          actionUrls: { fui: `${base}&presente=1`, faltei: `${base}&presente=0` },
        });
      }
    }
  }
  return out;
}

Deno.serve(async req => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
  const body = await req.json().catch(() => ({}));
  const now = new Date();

  const { data: subs } = await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth");
  const byUser = new Map<string, any[]>();
  for (const s of subs || []) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);
  if (!byUser.size) return Response.json({ sent: 0 });

  const { data: profiles } = await db.from("profiles").select("*").in("id", [...byUser.keys()]);
  let sent = 0;
  const report: string[] = [];

  for (const p of profiles || []) {
    // Teste manual: { "test": true } manda um aviso de exemplo para todo mundo inscrito
    const msgs: Msg[] = body.test
      ? [{ key: `teste:${now.getTime()}`, title: "Meu Semestre", body: "Notificações funcionando! 🎉", url: "/" }]
      : await messagesFor(p, now);
    for (const m of msgs) {
      // Grava antes de enviar: se a chave já existe, esse aviso já foi mandado
      const { error } = await db.from("notification_log").insert({ user_id: p.id, key: m.key });
      if (error) continue;
      const payload = JSON.stringify({ ...m, url: APP_URL + (m.url || "/"), actionUrls: Object.fromEntries(Object.entries(m.actionUrls || {}).map(([k, v]) => [k, APP_URL + v])) });
      for (const s of byUser.get(p.id) || []) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: "normal" });
          sent++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
          else report.push(`${m.key}: ${e?.statusCode || e?.message}`);
        }
      }
    }
  }
  return Response.json({ sent, errors: report });
});

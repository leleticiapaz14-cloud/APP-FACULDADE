import { createClient } from "@supabase/supabase-js";

export const configured = Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);

export const sb = configured
  ? createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const ok = ({ data, error }) => { if (error) throw error; return data; };

export async function loadAll(userId, since) {
  const [profile, subjects, attendance, sessions, events] = await Promise.all([
    sb.from("profiles").select("*").eq("id", userId).maybeSingle().then(ok),
    sb.from("subjects").select("*").order("position").order("created_at").then(ok),
    sb.from("attendance").select("id, subject_id, class_date, present").then(ok),
    sb.from("study_sessions").select("id, subject_id, started_at, minutes").gte("started_at", since.toISOString()).then(ok),
    sb.from("events").select("*").order("event_date").then(ok),
  ]);
  return { profile, subjects, attendance, sessions, events };
}

export const updateProfile = (id, patch) => sb.from("profiles").update(patch).eq("id", id).select().single().then(ok);

export const insertSubject = row => sb.from("subjects").insert(row).select().single().then(ok);
export const updateSubject = (id, patch) => sb.from("subjects").update(patch).eq("id", id).select().single().then(ok);
export const deleteSubject = id => sb.from("subjects").delete().eq("id", id).then(ok);

export const upsertAttendance = row =>
  sb.from("attendance").upsert(row, { onConflict: "subject_id,class_date" }).select("id, subject_id, class_date, present").single().then(ok);
export const deleteAttendance = id => sb.from("attendance").delete().eq("id", id).then(ok);

export const insertSession = row => sb.from("study_sessions").insert(row).select("id, subject_id, started_at, minutes").single().then(ok);
export const deleteSession = id => sb.from("study_sessions").delete().eq("id", id).then(ok);

export const insertEvent = row => sb.from("events").insert(row).select().single().then(ok);
export const deleteEvent = id => sb.from("events").delete().eq("id", id).then(ok);

export const savePushSubscription = row =>
  sb.from("push_subscriptions").upsert(row, { onConflict: "endpoint" }).then(ok);
export const deletePushSubscription = endpoint => sb.from("push_subscriptions").delete().eq("endpoint", endpoint).then(ok);

import "./style.css";
import { sb, configured, loadAll, updateProfile, insertSubject, updateSubject, deleteSubject, upsertAttendance, deleteAttendance, insertSession, deleteSession, insertEvent, deleteEvent } from "./db.js";
import { analyze, fmtN, parseN, NAME_RE } from "./grades.js";
import { pushState, enablePush, disablePush, isIOS } from "./push.js";
import { WD, WD_LONG, MONTHS, COLORS, TYPE_LABEL, today, iso, parse, daysUntil, addDays, weekStart, fmtMin, fmtDate, fmtTime, esc, color, greeting } from "./util.js";

const APP_HOME = location.origin + import.meta.env.BASE_URL;
const $ = id => document.getElementById(id);
const app = $("app");

let user = null;
let data = null; // { profile, subjects, attendance, sessions, events }
let ui = {
  view: "hoje", gradeSubj: null, calMonth: new Date().getMonth(), calYear: new Date().getFullYear(),
  selDay: iso(today()), filter: "todos", timerSubj: null, editing: null, authMode: "entrar", push: null, pendingAtt: null,
};
let tick = null;

// ---------- utilidades da tela ----------

function toast(msg, undo) {
  const t = $("toast");
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button type="button">Desfazer</button>` : ""}`;
  t.hidden = false;
  if (undo) t.querySelector("button").onclick = () => { t.hidden = true; undo(); };
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), undo ? 5000 : 2600);
}
const fail = e => { console.error(e); toast(e?.message?.includes("fetch") ? "Sem conexão. Tente de novo." : `Não deu certo: ${e?.message || e}`); };

const debouncers = {};
function later(key, fn, ms = 700) { clearTimeout(debouncers[key]); debouncers[key] = setTimeout(() => fn().catch(fail), ms); }

// ---------- dados derivados ----------

const subjById = id => data.subjects.find(s => s.id === id);
const minAtt = () => Number(data.profile?.min_attendance ?? 0.75);

function att(s) {
  const rows = data.attendance.filter(a => a.subject_id === s.id);
  const given = rows.length, absences = rows.filter(a => !a.present).length;
  const limit = Math.floor(s.total_classes * (1 - minAtt()) + 1e-9);
  const left = limit - absences;
  let st;
  if (!s.total_classes) st = { key: "atencao", label: "Defina o total de aulas" };
  else if (left < 0) st = { key: "critico", label: "Passou do limite" };
  else if (left <= 1) st = { key: "critico", label: left === 1 ? "Só mais 1 falta" : "No limite" };
  else if (limit && absences / limit >= 0.5) st = { key: "atencao", label: "Atenção" };
  else st = { key: "ok", label: "Tranquila" };
  return { rows, given, absences, limit, left, st, presence: given ? Math.round((given - absences) / given * 100) : null };
}

function weekMinutes(s) {
  const from = weekStart();
  return data.sessions.filter(x => x.subject_id === s.id && new Date(x.started_at) >= from).reduce((a, x) => a + x.minutes, 0);
}
function weekByDay() {
  const from = weekStart(), out = Array(7).fill(0);
  for (const x of data.sessions) {
    const d = new Date(x.started_at); if (d < from) continue;
    const i = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - from) / 86400000);
    if (i >= 0 && i < 7) out[i] += x.minutes;
  }
  return out;
}
const upcoming = () => data.events.filter(e => daysUntil(e.event_date) >= 0).sort((a, b) => a.event_date.localeCompare(b.event_date));
const classesOn = d => data.subjects.filter(s => (s.days || []).includes(d.getDay())).sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""));

function semesterLine() {
  const p = data.profile || {};
  const parts = [];
  if (p.semester_label) parts.push(esc(p.semester_label));
  if (p.semester_start && p.semester_end) {
    const total = Math.max(1, Math.ceil((parse(p.semester_end) - weekStart(parse(p.semester_start))) / (7 * 86400000)));
    const n = Math.floor((weekStart() - weekStart(parse(p.semester_start))) / (7 * 86400000)) + 1;
    if (n >= 1 && n <= total) parts.push(`semana ${n} de ${total}`);
    else if (n < 1) parts.push("semestre ainda não começou");
    else parts.push("semestre encerrado");
  }
  return parts.join(" · ") || "Seu semestre";
}

// ---------- pedaços de tela ----------

function dueRow(e, removable = false) {
  const s = subjById(e.subject_id), n = daysUntil(e.event_date), past = n < 0;
  return `<div class="card due" ${past ? 'style="opacity:.6"' : ""}>
    <div class="days ${!past && n <= 5 ? "soon" : ""}">${past ? `<span class="n">✓</span><span class="u">feito</span>` : `<span class="n">${n === 0 ? "hoje" : n}</span><span class="u">${n === 0 ? "" : n === 1 ? "dia" : "dias"}</span>`}</div>
    <div class="grow">
      <div class="row" style="gap:6px;flex-wrap:wrap"><span class="chip ${e.type}">${TYPE_LABEL[e.type]}</span><span class="small muted">${fmtDate(e.event_date)}</span></div>
      <div style="font-weight:600;margin-top:3px">${esc(e.title)}</div>
      <div class="small row" style="gap:6px">${s ? `<span class="dot" style="background:${color(s)}"></span>` : ""}<span class="muted">${s ? esc(s.name) : "Sem matéria"}${e.note ? " · " + esc(e.note) : ""}</span></div>
    </div>
    ${removable ? `<button class="x" data-act="del-event" data-id="${e.id}" aria-label="Apagar ${esc(e.title)}">×</button>` : ""}
  </div>`;
}

function studyBar(s, editable) {
  const done = weekMinutes(s), goal = s.weekly_goal_minutes;
  const pct = goal ? Math.min(100, done / goal * 100) : 0, hit = goal > 0 && done >= goal;
  return `<div style="display:flex;flex-direction:column;gap:6px">
    <div class="row"><span class="dot" style="background:${color(s)}"></span><span class="grow" style="font-weight:600">${esc(s.name)}</span>
      ${editable ? `<span class="goal-edit small"><span class="num">${fmtMin(done)}</span><span class="muted">de</span><button data-act="goal" data-id="${s.id}" data-d="-30" aria-label="Diminuir meta">−</button><b class="num">${fmtMin(goal)}</b><button data-act="goal" data-id="${s.id}" data-d="30" aria-label="Aumentar meta">+</button></span>`
        : `<span class="small"><span class="num">${fmtMin(done)}</span> <span class="muted">/ ${goal ? fmtMin(goal) : "sem meta"}</span></span>`}
      ${hit ? `<span class="chip ok">Meta batida</span>` : ""}
    </div>
    <div class="meter"><i style="width:${pct}%;background:${color(s)}"></i></div>
    ${editable && goal && !hit ? `<div class="small muted">Faltam ${fmtMin(goal - done)} para a meta</div>` : ""}
  </div>`;
}

const noSubjects = () => `<div class="card empty"><h2>Comece pelas suas matérias</h2>
  <div class="muted">Cadastre cada matéria com os dias, o horário e o total de aulas. Depois é só registrar presença, estudar e lançar notas.</div>
  <button class="btn primary" data-act="new-subject">Cadastrar matéria</button></div>`;

// Android/Chrome oferece instalar o app; guardamos o pedido para mostrar nosso próprio botão
let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (data && (ui.view === "hoje" || ui.view === "ajustes")) render(); });
window.addEventListener("appinstalled", () => { installPrompt = null; toast("App instalado! Abra pelo ícone Semestre."); if (data) render(); });
const installCard = () => installPrompt
  ? `<div class="alert soft"><span class="ic">↓</span><div class="grow"><b>Instale o app no celular</b> para abrir pelo ícone e receber os avisos.<div class="actions" style="margin-top:8px"><button class="btn primary" data-act="install">Instalar app</button></div></div></div>`
  : "";

function pushCard() {
  if (ui.push === "off") return `<div class="alert soft"><span class="ic">!</span><div class="grow"><b>Ative os avisos.</b> O app te lembra das provas, da meta de estudo e pergunta se você foi à aula.<div class="actions" style="margin-top:8px"><button class="btn primary" data-act="push-on">Ativar notificações</button></div></div></div>`;
  if (ui.push === "needs-install") return `<div class="alert soft"><span class="ic">!</span><div><b>Para receber avisos no iPhone:</b> toque em Compartilhar e depois em "Adicionar à Tela de Início". Abra o app pelo ícone e ative as notificações em Ajustes.</div></div>`;
  return "";
}

// ---------- telas ----------

const views = {
  hoje() {
    const t = today(), p = data.profile || {};
    const head = `<div><div class="eyebrow">${WD_LONG[t.getDay()]}, ${t.getDate()} de ${MONTHS[t.getMonth()]}</div><h1>${greeting()}${p.name ? `, ${esc(p.name.split(" ")[0])}` : ""}</h1></div>`;
    if (!data.subjects.length) return head + installCard() + pushCard() + noSubjects();

    const stats = data.subjects.map(s => [s, att(s)]);
    const crit = stats.filter(([, a]) => a.st.key === "critico" && a.limit);
    const withGoal = data.subjects.filter(s => s.weekly_goal_minutes > 0);
    const goalTotal = withGoal.reduce((a, s) => a + s.weekly_goal_minutes, 0);
    const goalDone = withGoal.reduce((a, s) => a + Math.min(weekMinutes(s), s.weekly_goal_minutes), 0);
    const given = stats.filter(([, a]) => a.given);
    const avgFreq = given.length ? Math.round(given.reduce((a, [, x]) => a + x.presence, 0) / given.length) : null;
    const next = upcoming(), in7 = next.filter(e => daysUntil(e.event_date) <= 7).length;

    // Aulas de hoje se ainda não acabaram, senão as de amanhã
    const now = new Date(), hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const todays = classesOn(t).filter(s => !s.end_time || fmtTime(s.end_time) > hm);
    const day = todays.length ? t : addDays(t, 1), cls = todays.length ? todays : classesOn(day);
    const dayLabel = todays.length ? "Aulas de hoje" : `Aulas de amanhã · ${WD[day.getDay()]} ${day.getDate()}/${day.getMonth() + 1}`;

    const pend = ui.pendingAtt && subjById(ui.pendingAtt.subject_id);
    return `${head}
      ${pend ? `<div class="alert soft"><span class="ic">?</span><div class="grow"><b>Você foi na aula de ${esc(pend.name)}?</b> <span class="muted">${fmtDate(ui.pendingAtt.date)}</span>
        <div class="actions" style="margin-top:8px"><button class="btn primary" data-act="pending" data-p="1">Fui</button><button class="btn danger" data-act="pending" data-p="0">Faltei</button><button class="link" data-act="pending" data-p="">Agora não</button></div></div></div>` : ""}
      ${installCard()}
      ${pushCard()}
      ${crit.map(([s, a]) => `<div class="alert"><span class="ic">!</span><div><b>${esc(s.name)}:</b> você já tem ${a.absences} ${a.absences === 1 ? "falta" : "faltas"} de ${a.limit} permitidas. ${a.left === 1 ? "Mais uma e fica no limite exato." : a.left < 0 ? "Fale com a coordenação sobre a sua situação." : ""} Evite faltar até o fim do semestre.</div></div>`).join("")}
      <div class="stats">
        <div class="stat"><span class="v">${avgFreq == null ? "–" : avgFreq + "%"}</span><span class="l">presença média</span></div>
        <div class="stat"><span class="v">${goalTotal ? Math.round(goalDone / goalTotal * 100) + "%" : "–"}</span><span class="l">da meta de estudo da semana</span></div>
        <div class="stat"><span class="v">${in7}</span><span class="l">entregas e provas em 7 dias</span></div>
      </div>
      <section>
        <div class="sec-head"><h2>${dayLabel}</h2></div>
        ${cls.length ? `<div class="card list" style="gap:12px">${cls.map(s => { const a = att(s); return `<div class="class-row"><span class="time">${fmtTime(s.start_time) || "–"}</span><span class="bar-v" style="background:${color(s)}"></span><div class="grow"><div style="font-weight:600">${esc(s.name)}</div><div class="small muted">${[s.room, s.professor].filter(Boolean).map(esc).join(" · ")}</div></div>${a.limit ? `<span class="chip ${a.st.key}">${Math.max(a.left, 0)} ${a.left === 1 ? "falta livre" : "faltas livres"}</span>` : ""}</div>`; }).join("")}</div>`
          : `<div class="info">Nenhuma aula marcada para ${todays.length ? "hoje" : "amanhã"}.</div>`}
      </section>
      <section>
        <div class="sec-head"><h2>Próximas provas e trabalhos</h2><button class="link" data-go="calendario">Ver calendário</button></div>
        ${next.length ? `<div class="list">${next.slice(0, 3).map(e => dueRow(e)).join("")}</div>` : `<div class="info">Nada marcado. Adicione provas e trabalhos no calendário.</div>`}
      </section>
      <section>
        <div class="sec-head"><h2>Estudo desta semana</h2><button class="link" data-go="estudo">Abrir</button></div>
        <div class="card list" style="gap:12px">${data.subjects.map(s => studyBar(s, false)).join("")}</div>
      </section>`;
  },

  frequencia() {
    const pct = Math.round(minAtt() * 100);
    const t = iso(today());
    return `
      <div><div class="eyebrow">Frequência</div><h1>Quantas faltas ainda posso ter?</h1>
      <p class="sub">Sua faculdade exige ${pct}% de presença. Registre cada aula e o app avisa antes de você chegar no limite.</p></div>
      ${!data.subjects.length ? noSubjects() : `<div class="list" style="gap:10px">
      ${data.subjects.map(s => {
        const a = att(s), todayRow = a.rows.find(r => r.class_date === t);
        const bar = a.limit ? Math.min(100, a.absences / a.limit * 100) : a.absences ? 100 : 0;
        const col = a.st.key === "critico" ? "var(--crit)" : a.st.key === "atencao" ? "var(--warn)" : "var(--accent)";
        const when = [(s.days || []).slice().sort().map(d => WD[d]).join(" e "), fmtTime(s.start_time)].filter(Boolean).join(" · ");
        const recent = a.rows.slice().sort((x, y) => y.class_date.localeCompare(x.class_date));
        return `<div class="card subj">
          <div class="subj-top">
            <span class="dot" style="background:${color(s)};margin-top:6px"></span>
            <div class="grow"><div class="subj-name">${esc(s.name)}</div><div class="small muted">${when || "dias não definidos"}${s.total_classes ? ` · ${s.total_classes} aulas no semestre` : ""}</div></div>
            <div><div class="big" style="color:${col}">${s.total_classes ? Math.max(a.left, 0) : "–"}</div><div class="small muted" style="text-align:right">${a.left === 1 ? "falta livre" : "faltas livres"}</div></div>
          </div>
          <div class="meter" aria-label="Faltas usadas"><i style="width:${bar}%;background:${col}"></i></div>
          <div class="legend"><span><span class="num">${a.absences}</span> de <span class="num">${a.limit}</span> faltas usadas</span><span class="chip ${a.st.key}">${a.st.label}</span></div>
          <div class="legend"><span>Presença até agora: <b class="num" style="color:var(--ink)">${a.presence == null ? "–" : a.presence + "%"}</b></span><span><span class="num">${a.given}</span>/<span class="num">${s.total_classes || "?"}</span> aulas registradas</span></div>
          <div class="actions">
            <button class="btn ${todayRow?.present ? "primary" : ""}" data-act="att" data-id="${s.id}" data-p="1">${todayRow?.present ? "✓ Fui hoje" : "Fui na aula"}</button>
            <button class="btn danger" data-act="att" data-id="${s.id}" data-p="0" ${todayRow && !todayRow.present ? 'style="border-color:var(--crit)"' : ""}>${todayRow && !todayRow.present ? "✓ Faltei hoje" : "Faltei"}</button>
          </div>
          ${recent.length ? `<details><summary class="small muted" style="cursor:pointer">Ver registros (${recent.length})</summary>
            <div class="list" style="gap:4px;margin-top:8px">${recent.map(r => `<div class="row small"><span class="grow">${fmtDate(r.class_date)}</span><span class="${r.present ? "" : "err"}">${r.present ? "presente" : "falta"}</span><button class="link" data-act="del-att" data-id="${r.id}" aria-label="Apagar registro">apagar</button></div>`).join("")}</div></details>` : ""}
        </div>`;
      }).join("")}
      </div>`}
      <div class="info">Registrou errado? Abra "Ver registros" na matéria e apague. Os botões marcam a aula de hoje; para outro dia, use o aviso que chega depois de cada aula.</div>`;
  },

  estudo() {
    if (!data.subjects.length) return `<div><div class="eyebrow">Estudo</div><h1>Suas metas de horas por matéria</h1></div>${noSubjects()}`;
    const days = weekByDay(), max = Math.max(...days, 1), total = days.reduce((a, b) => a + b, 0);
    const timer = readTimer();
    if (!ui.timerSubj || !subjById(ui.timerSubj)) ui.timerSubj = timer?.subj || data.subjects[0].id;
    const opts = data.subjects.map(s => `<option value="${s.id}" ${s.id === (timer?.subj || ui.timerSubj) ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    const ws = weekStart(), we = addDays(ws, 6), todayIdx = (today().getDay() + 6) % 7;
    return `
      <div><div class="eyebrow">Estudo</div><h1>Suas metas de horas por matéria</h1>
      <p class="sub">Defina quantas horas quer estudar de cada matéria por semana. Use o cronômetro ou lance o tempo depois.</p></div>
      <div class="timer">
        <span class="lbl">Cronômetro de estudo</span>
        <select id="timer-subj" aria-label="Matéria" ${timer ? "disabled" : ""}>${opts}</select>
        <div class="clock" id="clock">${clockText()}</div>
        <div class="actions">
          <button class="btn primary" data-act="timer">${timer ? "Parar e salvar" : "Começar"}</button>
          ${timer ? `<button class="btn" data-act="timer-cancel">Descartar</button>` : `<select id="manual-min" aria-label="Tempo para lançar" style="width:auto">${[15, 30, 45, 60, 90, 120].map(m => `<option value="${m}" ${m === 30 ? "selected" : ""}>${fmtMin(m)}</option>`).join("")}</select><button class="btn" data-act="manual">Lançar</button>`}
        </div>
      </div>
      <section>
        <div class="sec-head"><h2>Metas da semana</h2><span class="small muted">${WD[ws.getDay()]} ${ws.getDate()} a ${WD[we.getDay()]} ${we.getDate()}</span></div>
        <div class="card list" style="gap:14px">${data.subjects.map(s => studyBar(s, true)).join("")}</div>
      </section>
      <section>
        <div class="sec-head"><h2>Horas por dia</h2><span class="small muted">total <b class="num" style="color:var(--ink)">${fmtMin(total)}</b></span></div>
        <div class="card"><div class="week">
          ${days.map((m, i) => `<div class="col"><span class="h">${m ? fmtMin(m) : "–"}</span><div class="b ${m ? "" : "zero"} ${i === todayIdx ? "today" : ""}" style="height:${m ? Math.max(6, m / max * 80) : 4}px"></div><span class="d">${["seg", "ter", "qua", "qui", "sex", "sáb", "dom"][i]}</span></div>`).join("")}
        </div></div>
      </section>
      ${(() => {
        const recent = data.sessions.filter(x => new Date(x.started_at) >= ws).sort((a, b) => b.started_at.localeCompare(a.started_at));
        return recent.length ? `<details class="card"><summary class="small muted" style="cursor:pointer">Sessões desta semana (${recent.length})</summary><div class="list" style="gap:4px;margin-top:8px">
          ${recent.map(x => { const s = subjById(x.subject_id), d = new Date(x.started_at); return `<div class="row small"><span class="dot" style="background:${color(s)}"></span><span class="grow">${esc(s?.name || "")} · ${WD[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</span><span class="num">${fmtMin(x.minutes)}</span><button class="link" data-act="del-session" data-id="${x.id}">apagar</button></div>`; }).join("")}
        </div></details>` : "";
      })()}`;
  },

  notas() {
    if (!data.subjects.length) return `<div><div class="eyebrow">Notas</div><h1>Quanto preciso tirar?</h1></div>${noSubjects()}`;
    if (!subjById(ui.gradeSubj)) ui.gradeSubj = data.subjects[0].id;
    const s = subjById(ui.gradeSubj), comps = s.grade_components || [];
    const rule = (k, txt) => `<label class="rule" for="g-r-${k}"><span>${txt}</span><input id="g-r-${k}" data-rule="${k}" inputmode="decimal" value="${s[k] == null ? "" : fmtN(s[k])}"></label>`;
    return `
      <div><div class="eyebrow">Notas</div><h1>Quanto preciso tirar?</h1>
      <p class="sub">Escreva a conta que o professor usa e as regras de aprovação. O app calcula sua média e quanto falta nas próximas avaliações.</p></div>
      <div class="filters">${data.subjects.map(x => `<button data-act="gsubj" data-id="${x.id}" aria-pressed="${x.id === s.id}">${esc(x.name)}</button>`).join("")}</div>
      <div class="card grade">
        <label class="fld" for="g-formula">Conta do professor
          <input id="g-formula" value="${esc(s.grade_formula)}" placeholder="Ex.: (P1 + P2) / 2" spellcheck="false" autocomplete="off" autocapitalize="off">
        </label>
        <div class="small muted">Use os nomes das avaliações abaixo, números (0,4 ou 0.4), + − * / e parênteses. Também vale media( ), max( ) e min( ), separando com ponto e vírgula.</div>
        <div class="eyebrow">Avaliações · deixe em branco o que ainda não saiu</div>
        <div class="comps">
          ${comps.map((c, i) => `<div class="comp"><span class="cname num">${esc(c.n)}</span><input data-ci="${i}" inputmode="decimal" placeholder="—" value="${c.v == null ? "" : fmtN(c.v)}" aria-label="Nota de ${esc(c.n)}"><button class="x" data-act="rm-comp" data-i="${i}" aria-label="Remover ${esc(c.n)}">×</button></div>`).join("")}
        </div>
        <form id="g-add"><input id="g-newname" placeholder="Nova avaliação, ex.: P3" aria-label="Nome da nova avaliação" autocomplete="off" autocapitalize="characters"><button class="btn" type="submit">Adicionar</button></form>
        <div class="rules">
          <span class="eyebrow">Regras da matéria</span>
          ${rule("rule_direct", "Aprovada direto com média de pelo menos")}
          ${rule("rule_final", "Vai para a prova final com média de pelo menos")}
          ${rule("rule_final_pass", "Na final, passa se (média + final) ÷ 2 der pelo menos")}
        </div>
      </div>
      <div id="g-result">${gradeResult(s)}</div>`;
  },

  calendario() {
    const y = ui.calYear, m = ui.calMonth, t = iso(today());
    const startOff = new Date(y, m, 1).getDay();
    const cells = Array.from({ length: 42 }, (_, i) => new Date(y, m, 1 - startOff + i));
    const rows = cells.slice(35).every(d => d.getMonth() !== m) ? cells.slice(0, 35) : cells;
    const list = data.events.filter(e => ui.filter === "todos" || e.type === ui.filter);
    const dayEvents = data.events.filter(e => e.event_date === ui.selDay);
    const fBtn = (k, l) => `<button data-act="filter" data-f="${k}" aria-pressed="${ui.filter === k}">${l}</button>`;
    const subjOpts = data.subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("") + `<option value="">Sem matéria</option>`;
    return `
      <div><div class="eyebrow">Calendário</div><h1>Provas e trabalhos</h1></div>
      <div class="card" style="display:flex;flex-direction:column;gap:10px">
        <div class="cal-nav"><button data-act="month" data-d="-1" aria-label="Mês anterior">‹</button><span class="cal-month">${MONTHS[m]} ${y}</span><button data-act="month" data-d="1" aria-label="Próximo mês">›</button></div>
        <div class="cal">
          ${["d", "s", "t", "q", "q", "s", "s"].map(w => `<div class="wd">${w}</div>`).join("")}
          ${rows.map(d => {
            const k = iso(d), evs = data.events.filter(e => e.event_date === k);
            const cls = [d.getMonth() !== m ? "out" : "", k === t ? "today" : "", k === ui.selDay ? "sel" : ""].join(" ");
            return `<button class="cal-day ${cls}" data-act="day" data-day="${k}" aria-label="${d.getDate()} de ${MONTHS[d.getMonth()]}${evs.length ? ", " + evs.length + " evento(s)" : ""}">${d.getDate()}<span class="dots">${evs.slice(0, 3).map(e => `<span style="background:${color(subjById(e.subject_id))}"></span>`).join("")}</span></button>`;
          }).join("")}
        </div>
      </div>
      <section>
        <div class="sec-head"><h2>${fmtDate(ui.selDay)}</h2></div>
        ${dayEvents.length ? `<div class="list">${dayEvents.map(e => dueRow(e, true)).join("")}</div>` : `<div class="info">Nada marcado neste dia. Toque em outro dia ou adicione um evento abaixo.</div>`}
      </section>
      <section>
        <div class="sec-head"><h2>Adicionar prova ou trabalho</h2></div>
        <form class="add card" id="add-event">
          <label class="full">Título<input name="title" required maxlength="120" placeholder="Ex.: P2 de Resistência dos Materiais"></label>
          <label>Matéria<select name="subject_id">${subjOpts}</select></label>
          <label>Tipo<select name="type"><option value="prova">Prova</option><option value="trabalho">Trabalho</option><option value="seminario">Seminário</option></select></label>
          <label>Data<input name="event_date" type="date" required value="${ui.selDay}"></label>
          <label>Observação<input name="note" maxlength="200" placeholder="Ex.: capítulos 3 e 4"></label>
          <button class="btn primary full" type="submit">Adicionar ao calendário</button>
        </form>
      </section>
      <section>
        <div class="sec-head"><h2>Todos os eventos</h2></div>
        <div class="filters">${fBtn("todos", "Todos")}${fBtn("prova", "Provas")}${fBtn("trabalho", "Trabalhos")}${fBtn("seminario", "Seminários")}</div>
        ${list.length ? `<div class="list">${list.map(e => dueRow(e, true)).join("")}</div>` : `<div class="info">Nenhum evento ainda.</div>`}
      </section>`;
  },

  ajustes() {
    const p = data.profile || {};
    const pushLine = {
      "on": `<div class="toggle"><span><b>Notificações ativadas</b> neste aparelho.</span><button class="btn" data-act="push-off">Desativar</button></div><button class="btn" data-act="push-test">Mandar aviso de teste</button>`,
      "off": `<div class="toggle"><span>Receba avisos de provas, metas e aulas.</span><button class="btn primary" data-act="push-on">Ativar</button></div>`,
      "denied": `<div class="info">As notificações estão bloqueadas para este site. Libere nas configurações do navegador ou do celular e volte aqui.</div>`,
      "needs-install": `<div class="info">No iPhone, os avisos só funcionam com o app na Tela de Início: toque em Compartilhar, depois em "Adicionar à Tela de Início", e abra pelo ícone.</div>`,
      "unsupported": `<div class="info">Este navegador não aceita notificações. ${isIOS() ? "Use o Safari e adicione à Tela de Início." : "Tente o Chrome."}</div>`,
      "no-key": `<div class="info">As notificações ainda não foram configuradas no servidor.</div>`,
    }[ui.push] || `<div class="info">Verificando…</div>`;
    const pushHelp = ui.pushError && ui.push === "off" ? `<div class="info"><b>Não ativou?</b> No Android isso costuma ser o celular bloqueando o Chrome em segundo plano. Tente:<br>
      1. Configurações do celular → Apps → Chrome → Bateria: permitir atividade em segundo plano (sem restrição).<br>
      2. Configurações → Apps → Chrome → Notificações: ativadas.<br>
      3. Desligue VPN, bloqueador de anúncios ou "DNS privado" por um momento.<br>
      4. Atualize o "Google Play Services" na Play Store.<br>
      Depois feche o app e tente de novo.</div>` : "";
    const tg = (k, txt) => `<label class="toggle"><span>${txt}</span><input type="checkbox" data-pref="${k}" ${p[k] ? "checked" : ""}></label>`;
    return `
      <div><div class="eyebrow">Ajustes</div><h1>Seu semestre</h1></div>
      ${installCard()}
      <section><h2>Notificações</h2>
        <div class="card list" style="gap:12px">${pushLine}${pushHelp}
          ${tg("notify_study", "Lembrar da meta de estudo no fim da semana")}
          ${tg("notify_events", "Avisar de provas e trabalhos (3 dias e 1 dia antes)")}
          ${tg("notify_classes", "Perguntar se fui na aula, logo depois dela")}
        </div>
      </section>
      <section><div class="sec-head"><h2>Matérias</h2>${ui.editing ? "" : `<button class="link" data-act="new-subject">Adicionar</button>`}</div>
        ${ui.editing === "new" ? subjectForm({}) : ""}
        <div class="list">${data.subjects.map(s => ui.editing === s.id ? subjectForm(s) : `<div class="card row"><span class="dot" style="background:${color(s)}"></span><div class="grow"><div style="font-weight:600">${esc(s.name)}</div><div class="small muted">${[(s.days || []).slice().sort().map(d => WD[d]).join(", "), [fmtTime(s.start_time), fmtTime(s.end_time)].filter(Boolean).join("–"), s.total_classes ? `${s.total_classes} aulas` : ""].filter(Boolean).join(" · ") || "sem horário"}</div></div><button class="btn" data-act="edit-subject" data-id="${s.id}">Editar</button></div>`).join("")}</div>
        ${!data.subjects.length && ui.editing !== "new" ? `<div class="info">Nenhuma matéria ainda.</div>` : ""}
      </section>
      <section><h2>Semestre</h2>
        <form class="add card" id="profile-form">
          <label class="full">Seu nome<input name="name" value="${esc(p.name)}" maxlength="60"></label>
          <label class="full">Nome do semestre<input name="semester_label" value="${esc(p.semester_label)}" placeholder="Ex.: 2026.2" maxlength="30"></label>
          <label>Começa em<input name="semester_start" type="date" value="${p.semester_start || ""}"></label>
          <label>Termina em<input name="semester_end" type="date" value="${p.semester_end || ""}"></label>
          <label class="full">Presença mínima exigida (%)<input name="min_attendance" inputmode="numeric" value="${Math.round(minAtt() * 100)}"></label>
          <button class="btn primary full" type="submit">Salvar</button>
        </form>
      </section>
      <section><h2>Aparência</h2>
        <div class="card"><div class="filters" role="group" aria-label="Tema">${[["claro", "Claro"], ["escuro", "Escuro"], ["auto", "Igual ao celular"]].map(([k, l]) => `<button data-act="tema" data-t="${k}" aria-pressed="${getTheme() === k}">${l}</button>`).join("")}</div></div>
      </section>
      <section><h2>Conta</h2>
        <div class="card toggle"><span class="small muted">${esc(user.email)}</span><button class="btn danger" data-act="logout">Sair</button></div>
      </section>`;
  },
};

function subjectForm(s) {
  const isNew = !s.id, c = s.color || COLORS[data.subjects.length % COLORS.length];
  return `<form class="add card" id="subject-form" data-id="${s.id || ""}">
    <label class="full">Nome da matéria<input name="name" required maxlength="80" value="${esc(s.name)}" placeholder="Ex.: Resistência dos Materiais"></label>
    <label>Professor(a)<input name="professor" maxlength="80" value="${esc(s.professor)}"></label>
    <label>Sala<input name="room" maxlength="40" value="${esc(s.room)}" placeholder="Ex.: Bloco D · 302"></label>
    <div class="fld full">Dias da semana<div class="weekdays">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" name="days" value="${d}" ${(s.days || []).includes(d) ? "checked" : ""}><span>${WD[d]}</span></label>`).join("")}</div></div>
    <label>Começa às<input name="start_time" type="time" value="${fmtTime(s.start_time)}"></label>
    <label>Termina às<input name="end_time" type="time" value="${fmtTime(s.end_time)}"></label>
    <label>Total de aulas no semestre<input name="total_classes" inputmode="numeric" value="${s.total_classes ?? ""}" placeholder="Ex.: 36"><span class="hint">Cada dia de aula conta como 1.</span></label>
    <label>Meta de estudo por semana (horas)<input name="goal" inputmode="decimal" value="${s.weekly_goal_minutes ? fmtN(s.weekly_goal_minutes / 60) : ""}" placeholder="Ex.: 4"></label>
    <div class="fld full">Cor<div class="swatches">${COLORS.map(k => `<label><input type="radio" name="color" value="${k}" ${k === c ? "checked" : ""} aria-label="Cor ${k}"><span style="background:var(--${k})"></span></label>`).join("")}</div></div>
    <div class="actions full"><button class="btn primary" type="submit">${isNew ? "Adicionar matéria" : "Salvar"}</button><button class="btn" type="button" data-act="cancel-edit">Cancelar</button>${isNew ? "" : `<span class="grow"></span><button class="btn danger" type="button" data-act="del-subject" data-id="${s.id}">Apagar</button>`}</div>
  </form>`;
}

function gradeResult(s) {
  const comps = s.grade_components || [];
  const rules = { direct: s.rule_direct, final: s.rule_final, finalPass: s.rule_final_pass };
  const r = analyze(s.grade_formula, comps, rules);
  if (r.error) return `<div class="card gres bad"><b>Falta um detalhe:</b> ${esc(r.error)}</div>`;
  const pos = x => Math.max(0, Math.min(100, x * 10));
  const scale = (a, b) => `<div class="scale" aria-hidden="true"><span class="span" style="left:${pos(a)}%;width:${Math.max(1, pos(b) - pos(a))}%"></span><span class="tick" style="left:${pos(rules.final)}%"></span><span class="tick" style="left:${pos(rules.direct)}%"></span></div>
    <div class="legend"><span>0</span><span>final ${fmtN(rules.final)} · direto ${fmtN(rules.direct)}</span><span>10</span></div>`;
  if (r.done) {
    const chip = { direto: `<span class="chip ok">Aprovada direto</span>`, final: `<span class="chip atencao">Prova final</span>`, reprovada: `<span class="chip critico">Reprovada</span>` }[r.status];
    const line = r.status === "direto" ? "Todas as notas já saíram e você passou sem final."
      : r.status === "final" ? (r.finalNeed > 10 ? "Mesmo com 10 na final não dá para passar." : `Na final você precisa de pelo menos <b class="num">${fmtN(r.finalNeed)}</b>.`)
      : `A média ficou abaixo de ${fmtN(rules.final)}, que é o mínimo para fazer a final.`;
    return `<div class="card gres"><div class="head"><div><div class="eyebrow">Média final</div><div class="avg">${fmtN(r.avg)}</div></div>${chip}</div>${scale(r.avg, r.avg)}<div>${line}</div></div>`;
  }
  const each = r.missing.length > 1 ? `em cada uma (${r.missing.map(esc).join(", ")})` : `na ${esc(r.missing[0])}`;
  const row = (label, n) => `<div class="need"><span>${label}</span>${n == null ? `<span class="chip critico">Não dá mais</span>` : n === 0 ? `<span class="chip ok">Já garantido</span>` : `<span class="num">${fmtN(n)}</span>`}</div>`;
  return `<div class="card gres">
    <div class="head"><div><div class="eyebrow">Sua média vai ficar entre</div><div class="avg">${fmtN(r.lo)} e ${fmtN(r.hi)}</div></div><span class="chip atencao">Falta ${r.missing.map(esc).join(", ")}</span></div>
    ${scale(r.lo, r.hi)}
    ${row(`Para passar direto, tire ${each}`, r.needDirect)}
    ${row(`Para pelo menos ir para a final, tire ${each}`, r.needFinal)}
  </div>`;
}

// ---------- tema (guardado no aparelho) ----------

function getTheme() { try { return localStorage.getItem("ms-tema") || "claro"; } catch { return "claro"; } }
function applyTheme(t = getTheme()) {
  const dark = t === "escuro" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0F1411" : "#F2F4F0";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());

// ---------- cronômetro (guardado no aparelho, sobrevive a fechar o app) ----------

const TIMER_KEY = "ms-timer";
function readTimer() { try { return JSON.parse(localStorage.getItem(TIMER_KEY)); } catch { return null; } }
function writeTimer(t) { try { t ? localStorage.setItem(TIMER_KEY, JSON.stringify(t)) : localStorage.removeItem(TIMER_KEY); } catch { /* sem armazenamento */ } }
function clockText() {
  const t = readTimer(), s = t ? Math.max(0, Math.floor((Date.now() - t.start) / 1000)) : 0;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function syncTick() {
  clearInterval(tick); tick = null;
  if (readTimer()) tick = setInterval(() => { const c = $("clock"); if (c) c.textContent = clockText(); }, 1000);
}

// ---------- casca do app ----------

const TABS = [
  ["hoje", "Início", '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>'],
  ["frequencia", "Frequência", '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 5-6"/>'],
  ["estudo", "Estudo", '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>'],
  ["notas", "Notas", '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h4M14 3v5h5"/>'],
  ["calendario", "Calendário", '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
];

function shell() {
  app.innerHTML = `
    <header class="top pad">
      <div><div class="brand">Meu Semestre</div><div class="sem" id="sem"></div></div>
      <button class="icon-btn" data-go="ajustes" id="gear" aria-label="Ajustes"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
    </header>
    <main id="view" class="pad"></main>
    <nav class="tabs pad" role="tablist" aria-label="Seções">
      ${TABS.map(([k, l, svg]) => `<button class="tab" role="tab" data-go="${k}"><svg viewBox="0 0 24 24">${svg}</svg>${l}</button>`).join("")}
    </nav>`;
}

function render() {
  if (!$("view")) shell();
  $("sem").textContent = semesterLine();
  $("view").innerHTML = views[ui.view]();
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.go === ui.view));
  $("gear").setAttribute("aria-pressed", ui.view === "ajustes");
}
function go(v) { ui.view = v; ui.editing = null; render(); window.scrollTo(0, 0); }

// ---------- login ----------

function renderAuth(msg = "") {
  const m = ui.authMode;
  const title = { entrar: "Entrar", criar: "Criar conta", esqueci: "Recuperar senha", nova: "Nova senha" }[m];
  app.innerHTML = `<main class="auth pad">
    <div class="logo">MS</div>
    <div><h1>Meu Semestre</h1><p class="sub">Frequência, metas de estudo, notas e provas num lugar só.</p></div>
    ${!configured ? `<div class="alert"><span class="ic">!</span><div>O app ainda não está ligado ao banco de dados. Configure VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.</div></div>` : `
    <form id="auth-form" class="card">
      <h2>${title}</h2>
      ${m === "criar" ? `<label class="fld">Seu nome<input name="name" autocomplete="given-name" required></label>` : ""}
      ${m !== "nova" ? `<label class="fld">E-mail<input name="email" type="email" autocomplete="email" required></label>` : ""}
      ${m !== "esqueci" ? `<label class="fld">Senha<input name="password" type="password" minlength="6" autocomplete="${m === "entrar" ? "current-password" : "new-password"}" required></label>` : ""}
      ${msg ? `<div class="${msg.startsWith("✓") ? "small" : "err"}">${esc(msg)}</div>` : ""}
      <button class="btn primary block" type="submit">${{ entrar: "Entrar", criar: "Criar conta", esqueci: "Enviar link por e-mail", nova: "Salvar senha" }[m]}</button>
      <div class="actions" style="justify-content:space-between">
        ${m === "entrar" ? `<button type="button" class="link" data-auth="criar">Criar conta</button><button type="button" class="link" data-auth="esqueci">Esqueci a senha</button>` : m !== "nova" ? `<button type="button" class="link" data-auth="entrar">Já tenho conta</button>` : ""}
      </div>
    </form>`}
  </main>`;
}

async function onAuthSubmit(f) {
  const v = Object.fromEntries(new FormData(f)), btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    if (ui.authMode === "entrar") {
      const { error } = await sb.auth.signInWithPassword({ email: v.email, password: v.password });
      if (error) throw new Error(error.message.includes("Invalid") ? "E-mail ou senha incorretos." : error.message.includes("confirm") ? "Confirme seu e-mail antes de entrar (veja sua caixa de entrada)." : error.message);
    } else if (ui.authMode === "criar") {
      const { data: d, error } = await sb.auth.signUp({ email: v.email, password: v.password, options: { data: { name: v.name }, emailRedirectTo: APP_HOME } });
      if (error) throw error;
      if (!d.session) { ui.authMode = "entrar"; return renderAuth("✓ Conta criada. Abra o e-mail de confirmação e depois entre aqui."); }
    } else if (ui.authMode === "esqueci") {
      const { error } = await sb.auth.resetPasswordForEmail(v.email, { redirectTo: APP_HOME });
      if (error) throw error;
      ui.authMode = "entrar"; return renderAuth("✓ Se o e-mail estiver cadastrado, chega um link para criar uma nova senha.");
    } else if (ui.authMode === "nova") {
      const { error } = await sb.auth.updateUser({ password: v.password });
      if (error) throw error;
      ui.authMode = "entrar"; toast("Senha alterada"); return boot();
    }
  } catch (e) { renderAuth(e.message || String(e)); }
}

// ---------- ações ----------

async function recordAttendance(subject_id, class_date, present) {
  const row = await upsertAttendance({ subject_id, class_date, present });
  data.attendance = data.attendance.filter(a => !(a.subject_id === subject_id && a.class_date === class_date)).concat(row);
  render();
  const s = subjById(subject_id);
  toast(present ? `Presença registrada em ${s.name}` : `Falta registrada em ${s.name}`, () =>
    deleteAttendance(row.id).then(() => { data.attendance = data.attendance.filter(a => a.id !== row.id); render(); }).catch(fail));
}

async function addStudy(subject_id, minutes, started_at = new Date()) {
  const row = await insertSession({ subject_id, minutes, started_at: started_at.toISOString() });
  data.sessions.push(row); render();
  toast(`${fmtMin(minutes)} salvos em ${subjById(subject_id).name}`, () =>
    deleteSession(row.id).then(() => { data.sessions = data.sessions.filter(x => x.id !== row.id); render(); }).catch(fail));
}

async function refreshPush() { ui.push = await pushState().catch(() => "unsupported"); if (data && (ui.view === "ajustes" || ui.view === "hoje")) render(); }

const actions = {
  "att": t => recordAttendance(t.dataset.id, iso(today()), t.dataset.p === "1"),
  "del-att": async t => { await deleteAttendance(t.dataset.id); data.attendance = data.attendance.filter(a => a.id !== t.dataset.id); render(); },
  "pending": async t => {
    const p = ui.pendingAtt; ui.pendingAtt = null;
    if (t.dataset.p === "") return render();
    await recordAttendance(p.subject_id, p.date, t.dataset.p === "1");
  },
  "goal": t => {
    const s = subjById(t.dataset.id);
    s.weekly_goal_minutes = Math.max(0, s.weekly_goal_minutes + Number(t.dataset.d));
    render();
    later(`goal-${s.id}`, () => updateSubject(s.id, { weekly_goal_minutes: s.weekly_goal_minutes }));
  },
  "timer": async () => {
    const t = readTimer();
    if (!t) { writeTimer({ subj: $("timer-subj").value, start: Date.now() }); ui.timerSubj = $("timer-subj").value; syncTick(); return render(); }
    const minutes = Math.max(1, Math.round((Date.now() - t.start) / 60000));
    writeTimer(null); syncTick();
    if (!subjById(t.subj)) return render();
    await addStudy(t.subj, Math.min(minutes, 1440), new Date(t.start));
  },
  "timer-cancel": () => { if (confirm("Descartar o tempo do cronômetro?")) { writeTimer(null); syncTick(); render(); } },
  "manual": () => addStudy($("timer-subj").value, Number($("manual-min").value)),
  "del-session": async t => { await deleteSession(t.dataset.id); data.sessions = data.sessions.filter(x => x.id !== t.dataset.id); render(); },
  "gsubj": t => { ui.gradeSubj = t.dataset.id; render(); },
  "rm-comp": t => {
    const s = subjById(ui.gradeSubj), c = s.grade_components[Number(t.dataset.i)];
    if (c.v != null && !confirm(`Remover ${c.n} e a nota lançada?`)) return;
    s.grade_components.splice(Number(t.dataset.i), 1); render(); saveGrades(s);
  },
  "filter": t => { ui.filter = t.dataset.f; render(); },
  "month": t => { const d = new Date(ui.calYear, ui.calMonth + Number(t.dataset.d), 1); ui.calMonth = d.getMonth(); ui.calYear = d.getFullYear(); render(); },
  "day": t => { ui.selDay = t.dataset.day; const d = parse(ui.selDay); ui.calMonth = d.getMonth(); ui.calYear = d.getFullYear(); render(); },
  "del-event": async t => {
    const e = data.events.find(x => x.id === t.dataset.id);
    if (!confirm(`Apagar "${e.title}"?`)) return;
    await deleteEvent(e.id); data.events = data.events.filter(x => x.id !== e.id); render(); toast("Evento apagado");
  },
  "new-subject": () => { ui.view = "ajustes"; ui.editing = "new"; render(); $("subject-form")?.scrollIntoView({ block: "start" }); $("subject-form")?.querySelector("input")?.focus(); },
  "edit-subject": t => { ui.editing = t.dataset.id; render(); },
  "cancel-edit": () => { ui.editing = null; render(); },
  "del-subject": async t => {
    const s = subjById(t.dataset.id);
    if (!confirm(`Apagar ${s.name}? Frequência, estudo, notas e eventos dessa matéria também serão apagados.`)) return;
    await deleteSubject(s.id);
    data.subjects = data.subjects.filter(x => x.id !== s.id);
    data.attendance = data.attendance.filter(x => x.subject_id !== s.id);
    data.sessions = data.sessions.filter(x => x.subject_id !== s.id);
    data.events = data.events.filter(x => x.subject_id !== s.id);
    ui.editing = null; render(); toast("Matéria apagada");
  },
  "push-on": async t => {
    t.disabled = true;
    try { await enablePush(); ui.pushError = false; toast("Notificações ativadas"); }
    catch (e) { ui.pushError = true; toast(e.message); }
    await refreshPush(); render();
  },
  "push-test": async t => {
    t.disabled = true;
    const { data: r, error } = await sb.functions.invoke("send-reminders", { body: { test: true } });
    t.disabled = false;
    if (error) throw error;
    toast(r?.sent ? "Aviso enviado! Deve chegar em alguns segundos." : "Nenhum aparelho inscrito. Ative as notificações de novo.");
  },
  "push-off": async () => { await disablePush(); toast("Notificações desativadas"); await refreshPush(); },
  "install": async () => { const p = installPrompt; if (!p) return; installPrompt = null; await p.prompt(); render(); },
  "tema": t => { try { localStorage.setItem("ms-tema", t.dataset.t); } catch { /* sem armazenamento */ } applyTheme(t.dataset.t); render(); },
  "logout": async () => { await sb.auth.signOut(); },
};

function saveGrades(s) {
  later(`grades-${s.id}`, () => updateSubject(s.id, {
    grade_formula: s.grade_formula, grade_components: s.grade_components,
    rule_direct: s.rule_direct, rule_final: s.rule_final, rule_final_pass: s.rule_final_pass,
  }));
}

document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.auth) { ui.authMode = t.dataset.auth; return renderAuth(); }
  if (t.dataset.go) return go(t.dataset.go);
  const fn = actions[t.dataset.act];
  if (fn) Promise.resolve(fn(t)).catch(fail);
});

document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "timer-subj") ui.timerSubj = el.value;
  if (el.dataset.pref) {
    const k = el.dataset.pref, val = el.checked;
    data.profile[k] = val;
    updateProfile(user.id, { [k]: val }).catch(fail);
  }
});

document.addEventListener("input", e => {
  const el = e.target; if (ui.view !== "notas" || !data) return;
  const s = subjById(ui.gradeSubj); if (!s) return;
  if (el.id === "g-formula") s.grade_formula = el.value;
  else if (el.dataset.ci != null) s.grade_components[Number(el.dataset.ci)].v = parseN(el.value);
  else if (el.dataset.rule) s[el.dataset.rule] = parseN(el.value);
  else return;
  $("g-result").innerHTML = gradeResult(s);
  // Só salva o que é número válido; o resto fica só na tela até ser corrigido
  if (s.grade_components.some(c => Number.isNaN(c.v)) || [s.rule_direct, s.rule_final, s.rule_final_pass].some(x => x == null || Number.isNaN(x))) return;
  saveGrades(s);
});

document.addEventListener("submit", e => {
  const f = e.target;
  e.preventDefault();
  const run = fn => Promise.resolve(fn()).catch(fail);
  if (f.id === "auth-form") return onAuthSubmit(f);

  if (f.id === "g-add") return run(() => {
    const s = subjById(ui.gradeSubj), n = $("g-newname").value.trim();
    if (!NAME_RE.test(n)) return toast("Use um nome sem espaços, como P3 ou Lista2");
    if (s.grade_components.some(c => c.n.toLowerCase() === n.toLowerCase())) return toast(`Já existe uma avaliação chamada ${n}`);
    s.grade_components.push({ n, v: null }); render(); saveGrades(s);
    toast(`${n} adicionada. Inclua na conta do professor.`);
  });

  if (f.id === "add-event") return run(async () => {
    const v = Object.fromEntries(new FormData(f));
    const row = await insertEvent({ title: v.title.trim(), subject_id: v.subject_id || null, type: v.type, event_date: v.event_date, note: v.note.trim() });
    data.events.push(row); data.events.sort((a, b) => a.event_date.localeCompare(b.event_date));
    ui.selDay = row.event_date; const d = parse(row.event_date); ui.calMonth = d.getMonth(); ui.calYear = d.getFullYear();
    render(); toast("Adicionado ao calendário");
  });

  if (f.id === "subject-form") return run(async () => {
    const fd = new FormData(f), v = Object.fromEntries(fd);
    const goal = parseN(v.goal), total = parseInt(v.total_classes, 10);
    if (v.start_time && v.end_time && v.end_time <= v.start_time) return toast("O horário de término precisa ser depois do início");
    const row = {
      name: v.name.trim(), professor: v.professor.trim(), room: v.room.trim(), color: v.color,
      days: fd.getAll("days").map(Number), start_time: v.start_time || null, end_time: v.end_time || null,
      total_classes: Number.isFinite(total) && total > 0 ? total : 0,
      weekly_goal_minutes: goal > 0 ? Math.round(goal * 60) : 0,
    };
    if (f.dataset.id) {
      const saved = await updateSubject(f.dataset.id, row);
      data.subjects = data.subjects.map(s => (s.id === saved.id ? saved : s));
      toast("Matéria salva");
    } else {
      const saved = await insertSubject({ ...row, position: data.subjects.length });
      data.subjects.push(saved);
      toast(`${saved.name} adicionada`);
    }
    ui.editing = null; render();
  });

  if (f.id === "profile-form") return run(async () => {
    const v = Object.fromEntries(new FormData(f)), pct = parseN(v.min_attendance);
    if (!(pct > 0 && pct <= 100)) return toast("Presença mínima precisa estar entre 1 e 100");
    if (v.semester_start && v.semester_end && v.semester_end < v.semester_start) return toast("O fim do semestre precisa ser depois do início");
    data.profile = await updateProfile(user.id, {
      name: v.name.trim(), semester_label: v.semester_label.trim(),
      semester_start: v.semester_start || null, semester_end: v.semester_end || null, min_attendance: pct / 100,
    });
    render(); toast("Salvo");
  });
});

// Link vindo da notificação: ?registrar=<matéria>&data=AAAA-MM-DD[&presente=1|0]
// Link do e-mail que falhou volta com #error_code=...; explica em vez de só mostrar o login
function linkError() {
  const h = new URLSearchParams((window.__authHash || "").replace(/^#/, ""));
  window.__authHash = "";
  if (!h.get("error") && !h.get("error_code")) return "";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return h.get("error_code") === "otp_expired"
    ? "Esse link de confirmação venceu ou já foi usado. Se você pediu cadastro mais de uma vez, use o e-mail mais recente, ou tente entrar."
    : "O link do e-mail não funcionou. Tente entrar ou peça um novo.";
}

function readDeepLink() {
  const q = new URLSearchParams(location.search);
  const subject_id = q.get("registrar"), date = q.get("data"), p = q.get("presente"), view = q.get("aba");
  if (subject_id || view) history.replaceState(null, "", location.pathname);
  if (view && views[view]) ui.view = view;
  if (!subject_id || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return;
  if (p === "1" || p === "0") return { subject_id, date, present: p === "1" };
  ui.pendingAtt = { subject_id, date };
  ui.view = "hoje";
}

// ---------- início ----------

let booting = null;
const boot = () => (booting ||= start().finally(() => (booting = null)));

async function start() {
  const { data: { session } } = await sb.auth.getSession();
  user = session?.user || null;
  if (!user) { data = null; return renderAuth(linkError()); }
  if (ui.authMode === "nova") return renderAuth();
  app.innerHTML = `<div class="loading">Carregando…</div>`;
  try {
    data = await loadAll(user.id, addDays(weekStart(), -7 * 8));
    if (!data.profile) data.profile = { id: user.id, name: "", min_attendance: 0.75, notify_study: true, notify_events: true, notify_classes: true };
  } catch (e) {
    app.innerHTML = `<main class="auth pad"><div class="alert"><span class="ic">!</span><div>Não consegui carregar seus dados. Confira a internet e tente de novo.</div></div><button class="btn primary" onclick="location.reload()">Tentar de novo</button></main>`;
    return console.error(e);
  }
  const link = readDeepLink();
  if (ui.pendingAtt && !subjById(ui.pendingAtt.subject_id)) ui.pendingAtt = null;
  shell(); render(); syncTick();
  refreshPush();
  if (link && subjById(link.subject_id)) recordAttendance(link.subject_id, link.date, link.present).catch(fail);
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").catch(console.error);

if (!configured) renderAuth();
else {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { ui.authMode = "nova"; return renderAuth(); }
    if (event === "SIGNED_IN" && session?.user?.id !== user?.id) setTimeout(boot);
    if (event === "SIGNED_OUT") { user = null; data = null; ui.authMode = "entrar"; renderAuth(); }
  });
  boot();
}

// Ao voltar para o app depois de um tempo, recarrega os dados (ex.: virou a semana)
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (data && Date.now() - hiddenAt > 10 * 60 * 1000) boot();
});

export const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const WD_LONG = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
export const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const COLORS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
export const TYPE_LABEL = { prova: "Prova", trabalho: "Trabalho", seminario: "Seminário" };

export const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const daysUntil = s => Math.round((parse(s) - today()) / 86400000);
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// Semana de estudo vai de segunda a domingo
export function weekStart(d = today()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export const fmtMin = min => {
  const m = Math.round(min), hh = Math.floor(m / 60), mm = m % 60;
  return hh && mm ? `${hh}h${String(mm).padStart(2, "0")}` : hh ? `${hh}h` : `${mm}min`;
};
export const fmtDate = s => { const d = parse(s); return `${WD[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()].slice(0, 3)}`; };
export const fmtTime = t => (t || "").slice(0, 5);
export const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const color = s => `var(--${COLORS.includes(s?.color) ? s.color : "s1"})`;

export function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

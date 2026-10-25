// Cálculo de notas a partir da conta que o professor usa.

export const fmtN = n => (Math.round(n * 10) / 10).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const parseN = t => { t = String(t ?? "").trim().replace(",", "."); if (!t) return null; const n = Number(t); return isFinite(n) ? n : NaN; };
export const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ_][A-Za-zÀ-ÖØ-öø-ÿ_0-9]*$/;

const FN = { max: "F.max", min: "F.min", media: "F.avg", "média": "F.avg" };
const F = { max: Math.max, min: Math.min, avg: (...a) => a.reduce((x, y) => x + y, 0) / a.length };

// Transforma a conta digitada numa função. Só aceita números, nomes de avaliações,
// operadores e as funções acima, então nada além de aritmética chega ao new Function.
export function compile(src, names) {
  src = String(src ?? "").trim();
  if (!src) throw new Error("escreva a conta do professor.");
  const re = /\s*(?:(\d+(?:[.,]\d+)?)|([A-Za-zÀ-ÖØ-öø-ÿ_][A-Za-zÀ-ÖØ-öø-ÿ_0-9]*)|([-+*/()×÷;,]))/y;
  let out = "", i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { if (!src.slice(i).trim()) break; throw new Error(`não entendi o "${src.slice(i).trim()[0]}".`); }
    i = re.lastIndex;
    if (m[1]) out += m[1].replace(",", ".");
    else if (m[2]) {
      const low = m[2].toLowerCase(), name = names.find(n => n.toLowerCase() === low);
      if (name) out += `v[${JSON.stringify(name)}]`;
      else if (FN[low]) out += FN[low];
      else if (low === "x") out += "*";
      else throw new Error(`"${m[2]}" não é uma avaliação desta matéria. Adicione ou corrija o nome.`);
    } else out += ({ "×": "*", "÷": "/", ";": "," })[m[3]] || m[3];
  }
  let fn;
  try { fn = new Function("v", "F", `return (${out});`); } catch { throw new Error("confira os parênteses e os sinais."); }
  return v => {
    const r = fn(v, F);
    if (typeof r !== "number" || !isFinite(r)) throw new Error("a conta não deu um número.");
    return r;
  };
}

const up1 = x => Math.ceil(x * 10 - 1e-6) / 10;

// Analisa a situação da matéria. comps = [{ n, v }], v null = nota que ainda não saiu.
export function analyze(formula, comps, rules) {
  if (!comps.length) return { error: "adicione as avaliações da matéria (P1, P2...)." };
  if (comps.some(c => Number.isNaN(c.v))) return { error: "alguma nota não é um número." };
  const { direct, final, finalPass } = rules;
  if ([direct, final, finalPass].some(x => x == null || Number.isNaN(x))) return { error: "preencha as três regras com números." };
  let calc;
  try {
    const f = compile(formula, comps.map(c => c.n));
    calc = x => f(Object.fromEntries(comps.map(c => [c.n, c.v == null ? x : c.v])));
    calc(0); calc(10);
  } catch (e) { return { error: e.message }; }

  const missing = comps.filter(c => c.v == null).map(c => c.n);
  if (!missing.length) {
    const avg = calc(0);
    if (avg >= direct - 1e-9) return { done: true, avg, status: "direto" };
    if (avg >= final - 1e-9) return { done: true, avg, status: "final", finalNeed: up1(Math.max(0, 2 * finalPass - avg)) };
    return { done: true, avg, status: "reprovada" };
  }
  // Nota mínima igual em todas as avaliações que faltam (busca binária entre 0 e 10)
  const need = t => {
    if (calc(10) < t - 1e-9) return null;
    if (calc(0) >= t - 1e-9) return 0;
    let lo = 0, hi = 10;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; calc(mid) >= t ? hi = mid : lo = mid; }
    return up1(hi);
  };
  return { done: false, missing, lo: calc(0), hi: calc(10), needDirect: need(direct), needFinal: need(final) };
}

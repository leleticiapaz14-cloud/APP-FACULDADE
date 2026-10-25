import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, compile } from "../src/grades.js";

const rules = { direct: 7, final: 4, finalPass: 5 };

test("calcula a média com todas as notas", () => {
  const r = analyze("(P1 + P2) / 2", [{ n: "P1", v: 8 }, { n: "P2", v: 7 }], rules);
  assert.equal(r.done, true);
  assert.equal(r.avg, 7.5);
  assert.equal(r.status, "direto");
});

test("diz quanto precisa na final", () => {
  const r = analyze("(P1 + P2) / 2", [{ n: "P1", v: 5 }, { n: "P2", v: 4 }], rules);
  assert.equal(r.status, "final");
  assert.equal(r.finalNeed, 5.5);
});

test("diz quanto precisa nas avaliações que faltam", () => {
  const r = analyze("0,35*P1 + 0,35*P2 + 0,3*Trabalho", [{ n: "P1", v: 5 }, { n: "P2", v: null }, { n: "Trabalho", v: null }], rules);
  assert.equal(r.done, false);
  assert.deepEqual(r.missing, ["P2", "Trabalho"]);
  assert.equal(r.needDirect, 8.1);
  assert.equal(r.needFinal, 3.5);
});

test("aceita media( ) com ponto e vírgula e ×", () => {
  const f = compile("media(P1; P2) × 0,8 + Lab * 0,2", ["P1", "P2", "Lab"]);
  assert.equal(Math.round(f({ P1: 6, P2: 8, Lab: 10 }) * 100) / 100, 7.6);
});

test("recusa nomes desconhecidos e código", () => {
  assert.match(analyze("P1 + P9", [{ n: "P1", v: 1 }], rules).error, /P9/);
  assert.ok(analyze("alert(1)", [{ n: "P1", v: 1 }], rules).error);
  assert.ok(analyze("P1; constructor", [{ n: "P1", v: 1 }], rules).error);
});

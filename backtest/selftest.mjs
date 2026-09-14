// Auto-test du moteur de backtest.
//
// Un backtest qui se trompe est pire qu'aucun backtest : il donne une fausse
// assurance. On le vérifie donc sur des données dont on connaît la réponse.
//
//   Scénario A : marché parfaitement efficient. Le moteur doit conclure à
//                un rendement proche de moins la marge, et à aucun avantage.
//   Scénario B : marché biaisé de façon connue. Le moteur doit retrouver
//                le biais, sinon il est aveugle.
//
//   node backtest/selftest.mjs

import { backtest, summarize, calibration, outcomes, byMarket, splitSeasons, MARKET_NAMES } from "./engine.mjs";

const rnd = (() => { let s = 20260914; return () => (s = (s * 48271) % 2147483647) / 2147483647; })();
const poissonDraw = (l) => {
  let k = 0, p = 1, L = Math.exp(-l);
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
};

const MARGIN = 0.05;

// Génère un championnat fictif : forces d'équipes fixes, saisons complètes,
// et un marché qui connaît les vraies probabilités (au biais près).
function makeLeague({ teams = 20, seasons = 8, bias = 0, div = "T1" }) {
  const names = Array.from({ length: teams }, (_, i) => `E${i + 1}`);
  const att = new Map(), def = new Map();
  for (const n of names) {
    att.set(n, Math.exp((rnd() - 0.5) * 0.8));
    def.set(n, Math.exp((rnd() - 0.5) * 0.8));
  }
  const muH = 1.55, muA = 1.15;
  const matches = [];
  let day = Date.UTC(2014, 7, 1);

  for (let s = 0; s < seasons; s++) {
    const fixtures = [];
    for (const h of names) for (const a of names) if (h !== a) fixtures.push([h, a]);
    for (let i = fixtures.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [fixtures[i], fixtures[j]] = [fixtures[j], fixtures[i]];
    }
    for (const [h, a] of fixtures) {
      const lh = muH * att.get(h) * def.get(a);
      const la = muA * att.get(a) * def.get(h);
      const hg = poissonDraw(lh), ag = poissonDraw(la);
      const t = outcomes(lh, la, 0); // vraies probabilités, sans correction

      // Le marché connaît la vérité. Le biais éventuel déplace la probabilité
      // qu'il affiche pour la victoire à domicile.
      const pH = Math.min(0.95, Math.max(0.02, t.H * (1 + bias)));
      const rest = 1 - pH;
      const pD = t.D / (t.D + t.A) * rest, pA = rest - pD;
      const price = (p) => Math.max(1.01, 1 / (p * (1 + MARGIN)));

      matches.push({
        div, date: new Date(day), home: h, away: a, hg, ag,
        closeH: price(pH), closeD: price(pD), closeA: price(pA),
        openH: price(pH), openD: price(pD), openA: price(pA),
        closeO: price(t.O), closeU: price(t.U),
        openO: price(t.O), openU: price(t.U),
      });
      day += 2 * 864e5;
    }
    day += 60 * 864e5;
  }
  return matches.sort((a, b) => a.date - b.date);
}

function line(k, s) {
  if (!s.n) return `    ${k} : aucun pari`;
  return (
    `    ${k} : n=${String(s.n).padStart(5)} cote ${s.avgOdds.toFixed(2)} ` +
    `rendement ${(s.roi > 0 ? "+" : "") + s.roi.toFixed(2)} % ` +
    `[${(s.roi - s.ci).toFixed(1)} ; ${(s.roi + s.ci).toFixed(1)}] t=${s.tStat.toFixed(2)}`
  );
}

function run(title, matches, threshold) {
  const recs = backtest(matches, { halfLife: 240, prior: 8, minGames: 8 });
  const m = byMarket(recs, threshold);
  console.log(`\n${title} — ${recs.length} occasions, seuil ${(threshold * 100).toFixed(0)} %`);
  for (const k of Object.keys(MARKET_NAMES)) console.log(line(k, m[k]));
  return { recs, m };
}

console.log("=".repeat(70));
console.log("AUTO-TEST DU MOTEUR DE BACKTEST");
console.log("Un backtest faux est pire qu'aucun backtest : on le vérifie");
console.log("sur des données dont on connaît déjà la réponse.");
console.log("=".repeat(70));

const eff = makeLeague({ bias: 0, seasons: 14 });
console.log(`\nSCÉNARIO A — marché efficient, marge ${(MARGIN * 100).toFixed(0)} %`);
console.log(`${eff.length} matchs. Attendu : aucun marché durablement positif.`);
const A = run("Résultats", eff, 0.05);

const bias = -0.12;
const bia = makeLeague({ bias, seasons: 14, div: "T2" });
const attendu = ((1 / (1 + bias)) / (1 + MARGIN) - 1) * 100;
console.log(`\nSCÉNARIO B — le marché sous-évalue le domicile de ${Math.abs(bias * 100)} %`);
console.log(`${bia.length} matchs. Attendu sur le marché H : ${attendu.toFixed(1)} % de rendement.`);
const B = run("Résultats", bia, 0.05);

console.log("\nCalibration du modèle, scénario A :");
for (const c of calibration(A.recs)) {
  console.log(
    `  ${c.band.padEnd(12)} n=${String(c.n).padStart(5)} ` +
    `annoncé ${c.announced.toFixed(1)} % · observé ${c.observed.toFixed(1)} %`
  );
}

console.log("\nHors échantillon, scénario B, marché H :");
const sp = splitSeasons(B.recs.filter((r) => r.market === "H" && r.edge >= 0.05));
const tr = summarize(sp.train), te = summarize(sp.test);
console.log(`  apprentissage (${sp.trainSeasons.length} saisons) ${line("H", tr).slice(8)}`);
console.log(`  validation    (${sp.testSeasons.length} saisons) ${line("H", te).slice(8)}`);

console.log("\n" + "=".repeat(70));
const anyFalse = Object.values(A.m).some((s) => s.n > 200 && s.roi - s.ci > 0);
const checks = [
  ["A : aucun avantage inventé sur un marché efficient", !anyFalse],
  ["B : biais retrouvé sur le marché H", B.m.H.n > 500 && B.m.H.roi > 0],
  ["B : rendement conforme à la théorie (±3 pts)", Math.abs(B.m.H.roi - attendu) < 3],
  ["B : significatif (t > 2)", B.m.H.tStat > 2],
  ["B : tient hors échantillon", te.n > 100 && te.roi > 0],
  ["Calibration : écart moyen annoncé/observé < 5 pts",
    calibration(A.recs).reduce((a, c) => a + Math.abs(c.announced - c.observed), 0) /
      Math.max(1, calibration(A.recs).length) < 5],
];
let ko = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "OK   " : "ÉCHEC"} ${label}`);
  if (!ok) ko++;
}
console.log("=".repeat(70));
console.log(
  ko
    ? `${ko} contrôle(s) en échec : ne pas se fier aux résultats sur données réelles.`
    : "Tous les contrôles passent. Le moteur détecte un biais connu, n'en invente\npas quand il n'y en a pas, et son résultat tient hors échantillon."
);
process.exit(ko ? 1 : 0);

// Lance le backtest sur les fichiers téléchargés.
//
//   node backtest/run.mjs
//
// Discipline appliquée :
//   - le modèle ne voit jamais l'avenir ;
//   - chaque marché est jugé séparément, l'agrégation dilue tout ;
//   - le seuil se choisit sur les premières saisons et se juge sur les
//     dernières, jamais sur les mêmes.

import { readdir, readFile } from "node:fs/promises";
import {
  parseCsv, toMatches, backtest, summarize, byMarket,
  calibration, splitSeasons, MARKET_NAMES,
} from "./engine.mjs";

const dir = new URL("./data/", import.meta.url);
let files;
try {
  files = (await readdir(dir)).filter((f) => f.endsWith(".csv"));
} catch {
  console.error("Dossier backtest/data absent. Lance d'abord : node backtest/download.mjs");
  process.exit(1);
}
if (!files.length) { console.error("Aucun CSV. Lance node backtest/download.mjs"); process.exit(1); }

let matches = [];
for (const f of files) {
  const div = f.split("_")[1].replace(".csv", "");
  matches = matches.concat(toMatches(parseCsv(await readFile(new URL(f, dir), "latin1")), div));
}
matches.sort((a, b) => a.date - b.date);
const withOdds = matches.filter((m) => m.closeH && m.closeD && m.closeA);

console.log("=".repeat(72));
console.log(`${matches.length} matchs chargés, dont ${withOdds.length} avec cotes de clôture.`);
console.log(`Du ${matches[0]?.date.toISOString().slice(0, 10)} au ${matches.at(-1)?.date.toISOString().slice(0, 10)}.`);
console.log("=".repeat(72));

const recs = backtest(matches, { halfLife: 240, prior: 8, window: 900, minGames: 8, rho: -0.1 });
console.log(`\n${recs.length} occasions évaluées.\n`);

const sp = splitSeasons(recs, 0.3);
console.log(`Apprentissage : ${sp.trainSeasons.join(", ")}`);
console.log(`Validation    : ${sp.testSeasons.join(", ")}\n`);

const GRID = [0, 0.02, 0.05, 0.08, 0.12];
const fmt = (s) =>
  !s.n ? "        —" :
  `${String(s.n).padStart(6)} ${(s.roi > 0 ? "+" : "") + s.roi.toFixed(1)}% ±${s.ci.toFixed(1)}`;

console.log("APPRENTISSAGE — rendement par marché et par seuil");
console.log("marché".padEnd(24) + GRID.map((g) => `${(g * 100).toFixed(0)}%`.padStart(16)).join(""));
for (const k of Object.keys(MARKET_NAMES)) {
  const cells = GRID.map((g) => fmt(summarize(sp.train.filter((r) => r.market === k && r.edge >= g))));
  console.log(MARKET_NAMES[k].padEnd(24) + cells.map((c) => c.padStart(16)).join(""));
}

// Meilleure combinaison sur l'apprentissage, puis jugée sur la validation.
let bestKey = null, bestG = null, bestRoi = -Infinity;
for (const k of Object.keys(MARKET_NAMES)) {
  for (const g of GRID) {
    const s = summarize(sp.train.filter((r) => r.market === k && r.edge >= g));
    if (s.n >= 300 && s.roi > bestRoi) { bestRoi = s.roi; bestKey = k; bestG = g; }
  }
}

console.log("\n" + "=".repeat(72));
if (!bestKey) {
  console.log("Aucune combinaison n'atteint 300 paris sur l'apprentissage.");
  process.exit(0);
}
const tr = summarize(sp.train.filter((r) => r.market === bestKey && r.edge >= bestG));
const te = summarize(sp.test.filter((r) => r.market === bestKey && r.edge >= bestG));
console.log(`VALIDATION — ${MARKET_NAMES[bestKey]}, seuil ${(bestG * 100).toFixed(0)} %`);
console.log(`  (choisi sur l'apprentissage : c'est le seul chiffre qui compte)\n`);
const show = (lab, s) => {
  if (!s.n) return console.log(`  ${lab} : aucun pari`);
  console.log(
    `  ${lab} : n=${s.n} · cote ${s.avgOdds.toFixed(2)} · réussite ${s.winrate.toFixed(1)} %\n` +
    `    rendement ${(s.roi > 0 ? "+" : "") + s.roi.toFixed(2)} % ` +
    `[${(s.roi - s.ci).toFixed(1)} ; ${(s.roi + s.ci).toFixed(1)}] · t = ${s.tStat.toFixed(2)}\n` +
    `    écart à la clôture ${s.clv === null ? "—" : (s.clv > 0 ? "+" : "") + s.clv.toFixed(2) + " %"} ` +
    `(${s.clvN} paris) · Brier ${s.brier.toFixed(4)} contre marché ${s.brierMkt.toFixed(4)}`
  );
};
show("apprentissage", tr);
show("validation   ", te);

console.log("\nCalibration sur la validation :");
for (const c of calibration(sp.test)) {
  console.log(
    `  ${c.band.padEnd(12)} n=${String(c.n).padStart(6)} ` +
    `annoncé ${c.announced.toFixed(1)} % · observé ${c.observed.toFixed(1)} %`
  );
}

console.log("\n" + "=".repeat(72));
const verdict =
  !te.n ? "Pas assez de paris en validation pour conclure."
  : te.roi - te.ci > 0
  ? "Le rendement reste positif hors échantillon, marge d'erreur comprise.\nRésultat inhabituel : vérifier d'abord une fuite de données avant d'y croire."
  : te.roi > 0
  ? "Positif en validation mais l'intervalle contient zéro : indistinguable\nde la chance. Ne pas engager d'argent sur cette base."
  : "Négatif en validation. Le modèle ne bat pas la clôture. C'est le\nrésultat le plus probable, et il a la valeur d'une réponse.";
console.log(verdict);
console.log("=".repeat(72));

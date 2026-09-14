// Test de règles de ciblage.
//
// Le backtest principal ne filtrait que sur l'écart au prix. Ici on teste des
// critères d'un autre genre : séries de disette, équipes sans victoire, cotes
// dans une fourchette, publication limitée à quelques paris par semaine.
//
//   node backtest/targeted.mjs
//
// AVERTISSEMENT DE MÉTHODE : tester plusieurs règles sur les mêmes données
// garantit qu'au moins l'une paraîtra bonne par hasard. Avec dix règles, la
// probabilité qu'au moins une franchisse le seuil habituel de significativité
// alors qu'aucune ne vaut rien est d'environ 40 %. Le seuil est donc relevé
// en conséquence (correction de Bonferroni), et seule la validation compte.

import { readdir, readFile } from "node:fs/promises";
import {
  parseCsv, toMatches, backtest, summarize, splitSeasons, weeklyTop,
} from "./engine.mjs";

const dir = new URL("./data/", import.meta.url);
let files;
try {
  files = (await readdir(dir)).filter((f) => f.endsWith(".csv"));
} catch {
  console.error("Lance d'abord : node backtest/download.mjs");
  process.exit(1);
}

let matches = [];
for (const f of files) {
  const div = f.split("_")[1].replace(".csv", "");
  matches = matches.concat(toMatches(parseCsv(await readFile(new URL(f, dir), "latin1")), div));
}
matches.sort((a, b) => a.date - b.date);

console.log("=".repeat(74));
console.log(`${matches.length} matchs. Test de règles de ciblage.`);
console.log("=".repeat(74));

const recs = backtest(matches, { halfLife: 240, prior: 8, window: 900, minGames: 8 });
const sp = splitSeasons(recs, 0.3);
console.log(`\nApprentissage ${sp.trainSeasons.join(", ")}`);
console.log(`Validation    ${sp.testSeasons.join(", ")}\n`);

// Chaque règle reçoit l'ensemble des occasions et renvoie celles qu'elle retient.
const RULES = [
  {
    name: "5 meilleurs écarts par semaine",
    apply: (r) => weeklyTop(r, 5),
  },
  {
    name: "1 seul meilleur écart par semaine",
    apply: (r) => weeklyTop(r, 1),
  },
  {
    name: "Probabilité ≥ 60 % et écart ≥ 5 %",
    apply: (r) => r.filter((x) => x.model >= 0.6 && x.edge >= 0.05),
  },
  {
    name: "Probabilité ≥ 70 %",
    apply: (r) => r.filter((x) => x.model >= 0.7),
  },
  {
    name: "Écart ≥ 20 %",
    apply: (r) => r.filter((x) => x.edge >= 0.2),
  },
  {
    name: "Cote entre 1,50 et 2,50, écart ≥ 5 %",
    apply: (r) => r.filter((x) => x.close >= 1.5 && x.close <= 2.5 && x.edge >= 0.05),
  },
  {
    name: "Deux attaques muettes → moins de 2,5",
    apply: (r) => r.filter((x) => x.market === "U" && x.hScored3 <= 1 && x.aScored3 <= 1),
  },
  {
    name: "Visiteur sans victoire sur 5 → domicile",
    apply: (r) => r.filter((x) => x.market === "H" && x.aPoints5 <= 2),
  },
  {
    name: "Visiteur effondré + écart ≥ 5 % → domicile",
    apply: (r) => r.filter((x) => x.market === "H" && x.aPoints5 <= 2 && x.edge >= 0.05),
  },
  {
    name: "Deux défenses en perdition → plus de 2,5",
    apply: (r) => r.filter((x) => x.market === "O" && x.hConceded3 >= 5 && x.aConceded3 >= 5),
  },
];

const BONF = 2.81; // seuil de t pour 10 règles testées, équivalent à 5 % global

const row = (s) =>
  !s.n
    ? "aucun pari"
    : `n=${String(s.n).padStart(5)} cote ${s.avgOdds.toFixed(2)} ` +
      `rendement ${(s.roi > 0 ? "+" : "") + s.roi.toFixed(2)} % ` +
      `[${(s.roi - s.ci).toFixed(1)} ; ${(s.roi + s.ci).toFixed(1)}] t=${s.tStat.toFixed(2)}`;

console.log("APPRENTISSAGE");
const scored = [];
for (const rule of RULES) {
  const s = summarize(rule.apply(sp.train));
  scored.push({ rule, s });
  console.log(`  ${rule.name}`);
  console.log(`      ${row(s)}`);
}

const viable = scored.filter((x) => x.s.n >= 200);
viable.sort((a, b) => b.s.roi - a.s.roi);

console.log("\n" + "=".repeat(74));
if (!viable.length) {
  console.log("Aucune règle n'atteint 200 paris sur l'apprentissage.");
  process.exit(0);
}

const champ = viable[0];
console.log(`VALIDATION — règle la plus rentable sur l'apprentissage :`);
console.log(`  « ${champ.rule.name} »\n`);
const te = summarize(champ.rule.apply(sp.test));
console.log(`  apprentissage : ${row(champ.s)}`);
console.log(`  validation    : ${row(te)}`);
if (te.clv !== null) {
  console.log(
    `  écart à la clôture en validation : ` +
    `${(te.clv > 0 ? "+" : "") + te.clv.toFixed(2)} % sur ${te.clvN} paris`
  );
}

console.log("\nToutes les règles en validation :");
for (const { rule } of viable) {
  const s = summarize(rule.apply(sp.test));
  console.log(`  ${rule.name.padEnd(44)} ${row(s)}`);
}

console.log("\n" + "=".repeat(74));
const anyReal = viable.some((x) => {
  const s = summarize(x.rule.apply(sp.test));
  return s.n >= 200 && s.tStat > BONF;
});
console.log(
  anyReal
    ? `Au moins une règle dépasse t = ${BONF} en validation, seuil corrigé pour\n` +
      `${RULES.length} essais. Résultat inhabituel : chercher d'abord une fuite de données.`
    : `Aucune règle ne dépasse t = ${BONF} en validation, seuil corrigé pour\n` +
      `${RULES.length} essais. Le ciblage ne change pas la conclusion : ce qui paraît\n` +
      `rentable sur l'apprentissage ne tient pas ensuite.`
);
console.log("=".repeat(74));

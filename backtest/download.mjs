// Télécharge les archives de football-data.co.uk.
// Données gratuites : résultats et cotes de clôture, dix saisons, sept
// championnats. C'est la seule source publique qui donne la cote de clôture,
// donc la seule qui permette de mesurer autre chose que de la chance.
//
//   node backtest/download.mjs            dix dernières saisons
//   node backtest/download.mjs 15         quinze saisons

import { mkdir, writeFile } from "node:fs/promises";

const DIVS = {
  E0: "Premier League", SP1: "Liga", D1: "Bundesliga", I1: "Serie A",
  F1: "Ligue 1", N1: "Eredivisie", P1: "Liga Portugal", B1: "Jupiler Pro League",
};

const nSeasons = Number(process.argv[2] || 10);
const now = new Date();
const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;

await mkdir(new URL("./data/", import.meta.url), { recursive: true });
let ok = 0, ko = 0;

for (let k = 0; k < nSeasons; k++) {
  const y = startYear - k;
  const code = String(y % 100).padStart(2, "0") + String((y + 1) % 100).padStart(2, "0");
  for (const div of Object.keys(DIVS)) {
    const url = `https://www.football-data.co.uk/mmz4281/${code}/${div}.csv`;
    try {
      const r = await fetch(url);
      if (!r.ok) { ko++; continue; }
      const text = await r.text();
      if (text.length < 500) { ko++; continue; }
      await writeFile(new URL(`./data/${code}_${div}.csv`, import.meta.url), text);
      ok++;
      process.stdout.write(`\r${ok} fichier(s) récupéré(s)…`);
    } catch { ko++; }
    await new Promise((r) => setTimeout(r, 250));
  }
}
console.log(`\n${ok} fichier(s) dans backtest/data, ${ko} absent(s) ou indisponible(s).`);
console.log("Les saisons anciennes n'ont pas toujours les cotes de clôture : c'est normal.");

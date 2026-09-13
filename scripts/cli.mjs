#!/usr/bin/env node
// Outil en ligne de commande de Cote à Cote.
// Tourne dans GitHub Actions, sans aucune dépendance : Node 20+ suffit.
//
//   node scripts/cli.mjs settle    règle les rencontres terminées
//   node scripts/cli.mjs add       publie un pari (entrées via variables d'env)
//   node scripts/cli.mjs odds      enregistre des cotes

import { readFile, writeFile } from "node:fs/promises";

const FILE = new URL("../data/picks.json", import.meta.url);

export const COMPETITIONS = {
  PL: "Premier League",
  PD: "Liga",
  BL1: "Bundesliga",
  SA: "Serie A",
  FL1: "Ligue 1",
  DED: "Eredivisie",
  PPL: "Liga Portugal",
};

const BOOKS = ["winamax", "betclic", "unibet"];

async function load() {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return { picks: [], updatedAt: null };
  }
}

async function save(db) {
  db.updatedAt = new Date().toISOString();
  await writeFile(FILE, JSON.stringify(db, null, 2) + "\n");
}

const die = (msg) => {
  console.error("Erreur : " + msg);
  process.exit(1);
};

const best = (o) => {
  const v = Object.values(o || {}).filter(Boolean);
  return v.length ? Math.max(...v) : null;
};

/* ------------------------------------------------------------- règlement */

// Renvoie "won", "lost", "void", ou null si le marché n'est pas décidable
// à partir du seul score final.
export function settle(market, home, away) {
  const m = String(market).trim().toUpperCase();
  const total = home + away;

  if (m === "1") return home > away ? "won" : "lost";
  if (m === "X") return home === away ? "won" : "lost";
  if (m === "2") return away > home ? "won" : "lost";
  if (m === "1X") return home >= away ? "won" : "lost";
  if (m === "X2") return away >= home ? "won" : "lost";
  if (m === "12") return home !== away ? "won" : "lost";
  if (m === "BTTS") return home > 0 && away > 0 ? "won" : "lost";
  if (m === "NOBTTS") return home === 0 || away === 0 ? "won" : "lost";

  const ou = m.match(/^([OU])(\d+(?:\.\d+)?)$/);
  if (ou) {
    const line = parseFloat(ou[2]);
    if (total === line) return "void";
    return (ou[1] === "O") === total > line ? "won" : "lost";
  }
  return null;
}

async function cmdSettle() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) die("FOOTBALL_DATA_TOKEN absent des secrets du dépôt.");

  const db = await load();
  const waiting = db.picks.filter((p) => p.status === "pending" && p.matchId);
  if (!waiting.length) return console.log("Aucun pari en attente à régler.");

  const codes = [...new Set(waiting.map((p) => p.comp))];
  const now = Date.now();
  const from = new Date(now - 8 * 864e5).toISOString().slice(0, 10);
  const to = new Date(now + 864e5).toISOString().slice(0, 10);

  const url =
    `https://api.football-data.org/v4/matches?competitions=${codes.join(",")}` +
    `&dateFrom=${from}&dateTo=${to}`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) die(`football-data a répondu ${res.status}`);

  const byId = new Map(((await res.json()).matches || []).map((m) => [String(m.id), m]));
  let done = 0;

  for (const p of waiting) {
    const m = byId.get(String(p.matchId));
    if (!m || m.status !== "FINISHED") continue;
    const ft = m.score.fullTime;
    if (ft.home == null || ft.away == null) continue;

    p.score = `${ft.home}-${ft.away}`;
    const issue = settle(p.market, ft.home, ft.away);
    if (issue) {
      p.status = issue;
      p.settledAt = new Date().toISOString();
      done++;
      console.log(`${p.match} ${p.score} → ${issue}`);
    } else {
      p.needsManual = true;
      console.log(`${p.match} ${p.score} → règlement manuel (${p.market})`);
    }
  }

  if (done || waiting.some((p) => p.needsManual)) await save(db);
  console.log(`${done} pari(s) réglé(s).`);
}

/* ------------------------------------------------------------ publication */

async function cmdAdd() {
  const e = process.env;
  const comp = (e.COMP || "").trim();
  const match = (e.MATCH || "").trim();
  const market = (e.MARKET || "").trim().toUpperCase();
  const kickoff = (e.KICKOFF || "").trim();

  if (!COMPETITIONS[comp]) die(`Championnat inconnu : ${comp}`);
  if (!match) die("La rencontre est obligatoire.");
  if (!market) die("Le code du marché est obligatoire.");

  const ko = new Date(kickoff);
  if (Number.isNaN(+ko)) die(`Coup d'envoi illisible : ${kickoff}`);
  if (+ko <= Date.now()) die("Le coup d'envoi est déjà passé. Un pari se publie avant.");

  const db = await load();
  const pick = {
    id: "p" + Date.now().toString(36),
    publishedAt: new Date().toISOString(),
    comp,
    match,
    market,
    label: (e.LABEL || "").trim() || market,
    kickoff: ko.toISOString(),
    matchId: (e.MATCH_ID || "").trim() || null,
    why: (e.WHY || "").trim(),
    caveat: (e.CAVEAT || "").trim(),
    odds: null,
    oddsTaken: null,
    oddsClose: null,
    status: "pending",
    score: null,
  };
  db.picks.push(pick);
  await save(db);
  console.log(`Publié : ${pick.match} — ${pick.label} (${pick.id})`);
}

/* ------------------------------------------------------------------ cotes */

async function cmdOdds() {
  const e = process.env;
  const id = (e.PICK_ID || "").trim();
  const phase = (e.PHASE || "").trim();
  if (!["open", "close"].includes(phase)) die("PHASE doit valoir open ou close.");

  const db = await load();
  const p = db.picks.find((x) => x.id === id);
  if (!p) die(`Pari introuvable : ${id}`);

  const o = {};
  for (const b of BOOKS) {
    const raw = e[b.toUpperCase()];
    if (raw === undefined || raw === "") {
      o[b] = null;
      continue;
    }
    const n = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n <= 1) die(`Cote ${b} invalide : ${raw}`);
    o[b] = n;
  }
  if (!Object.values(o).some(Boolean)) die("Au moins une cote est requise.");

  p.odds = o;
  if (phase === "open") {
    if (p.oddsTaken) die("La cote de ce pari est déjà figée. Elle ne se modifie pas.");
    p.oddsTaken = best(o);
  } else {
    p.oddsClose = best(o);
  }
  await save(db);
  console.log(`${p.match} — ${phase === "open" ? "cote du pari" : "cote de clôture"} : ${best(o)}`);
}

/* ---------------------------------------------------------------- routeur */

const CMDS = { settle: cmdSettle, add: cmdAdd, odds: cmdOdds };
const cmd = process.argv[2];

if (!CMDS[cmd]) {
  console.error(`Commande attendue : ${Object.keys(CMDS).join(", ")}`);
  process.exit(1);
}
await CMDS[cmd]().catch((err) => die(err.message));

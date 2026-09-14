#!/usr/bin/env node
// Outil en ligne de commande de Cote à Cote.
// Aucune dépendance : Node 20+ suffit.
//
//   node scripts/cli.mjs settle    règle les rencontres terminées
//   node scripts/cli.mjs add       publie un pari (entrées via variables d'env)
//   node scripts/cli.mjs odds      enregistre des cotes
//   node scripts/cli.mjs manual    règle à la main un pari non décidable
//   node scripts/cli.mjs fixtures  liste les match_id d'une journée

import { readFile, writeFile } from "node:fs/promises";

const FILE = new URL("../data/picks.json", import.meta.url);

// Les 12 compétitions du palier gratuit de football-data.
// Coupes nationales, Europa League et amicaux exigent le palier à 49 €/mois.
export const COMPETITIONS = {
  PL: "Premier League",
  PD: "Liga",
  BL1: "Bundesliga",
  SA: "Serie A",
  FL1: "Ligue 1",
  DED: "Eredivisie",
  PPL: "Liga Portugal",
  ELC: "Championship",
  BSA: "Brasileirão",
  CL: "Ligue des Champions",
  EC: "Championnat d'Europe",
  WC: "Coupe du Monde",
};

const BOOKS = ["winamax", "betclic", "unibet"];
const MAX_STAKE = 0.02; // plafond de mise : 2 % du capital

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

// Un combiné tombe dès qu'une jambe tombe. Il ne gagne que si toutes passent.
// Les jambes remboursées sont retirées du calcul, comme chez le bookmaker.
export function settleParlay(legs) {
  if (legs.some((l) => l.status === "lost")) return "lost";
  if (legs.some((l) => !l.status || l.status === "pending")) return null;
  return legs.every((l) => l.status === "void") ? "void" : "won";
}

// Toutes les jambes en attente d'un pari, combiné ou non.
const legsOf = (p) =>
  p.legs && p.legs.length ? p.legs : [{ comp: p.comp, matchId: p.matchId, market: p.market, holder: p }];

async function cmdSettle() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) die("FOOTBALL_DATA_TOKEN absent des secrets du dépôt.");

  const db = await load();
  const waiting = db.picks.filter((p) => p.status === "pending");
  if (!waiting.length) return console.log("Aucun pari en attente à régler.");

  const codes = [
    ...new Set(waiting.flatMap((p) => legsOf(p).map((l) => l.comp)).filter(Boolean)),
  ];
  if (!codes.length) return console.log("Aucun pari relié à un match identifié.");

  const now = Date.now();
  const from = new Date(now - 8 * 864e5).toISOString().slice(0, 10);
  const to = new Date(now + 864e5).toISOString().slice(0, 10);
  const url =
    `https://api.football-data.org/v4/matches?competitions=${codes.join(",")}` +
    `&dateFrom=${from}&dateTo=${to}`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) die(`football-data a répondu ${res.status}`);

  const byId = new Map(((await res.json()).matches || []).map((m) => [String(m.id), m]));
  let done = 0, changed = false;

  for (const p of waiting) {
    const legs = p.legs && p.legs.length ? p.legs : null;

    if (!legs) {
      if (!p.matchId) continue;
      const m = byId.get(String(p.matchId));
      if (!m || m.status !== "FINISHED") continue;
      const ft = m.score.fullTime;
      if (ft.home == null || ft.away == null) continue;
      p.score = `${ft.home}-${ft.away}`;
      changed = true;
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
      continue;
    }

    // Combiné : on règle chaque jambe, puis l'ensemble.
    for (const l of legs) {
      if (l.status && l.status !== "pending") continue;
      const m = l.matchId && byId.get(String(l.matchId));
      if (!m || m.status !== "FINISHED") continue;
      const ft = m.score.fullTime;
      if (ft.home == null || ft.away == null) continue;
      l.score = `${ft.home}-${ft.away}`;
      const issue = settle(l.market, ft.home, ft.away);
      if (issue) {
        l.status = issue;
        changed = true;
        console.log(`  jambe ${l.match || l.matchId} ${l.score} → ${issue}`);
      } else {
        l.needsManual = true;
      }
    }
    const overall = settleParlay(legs);
    if (overall) {
      p.status = overall;
      p.settledAt = new Date().toISOString();
      done++;
      changed = true;
      console.log(`${p.match} (combiné) → ${overall}`);
    }
  }

  if (changed) await save(db);
  console.log(`${done} pari(s) réglé(s).`);
}

/* ------------------------------------------------------------ publication */

// Va chercher écussons et noms officiels. Valide aussi l'identifiant :
// une faute de saisie se verrait sinon une semaine plus tard, au règlement.
async function fetchMatch(matchId) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!matchId || !token) return null;
  const r = await fetch(`https://api.football-data.org/v4/matches/${matchId}`, {
    headers: { "X-Auth-Token": token },
  });
  if (!r.ok) throw new Error(`identifiant ${matchId} refusé (${r.status})`);
  const m = await r.json();
  return {
    home: { name: m.homeTeam.shortName || m.homeTeam.name, crest: m.homeTeam.crest || null },
    away: { name: m.awayTeam.shortName || m.awayTeam.name, crest: m.awayTeam.crest || null },
  };
}

function readStake(raw) {
  if (!raw) return 0.01;
  const n = Number(String(raw).replace(",", ".").replace("%", "")) / 100;
  if (!Number.isFinite(n) || n <= 0) die(`Mise illisible : ${raw}`);
  if (n > MAX_STAKE) {
    die(`Mise de ${(n * 100).toFixed(1)} % refusée. Le plafond est ${MAX_STAKE * 100} %.`);
  }
  return n;
}

async function cmdAdd() {
  const e = process.env;
  const comp = (e.COMP || "").trim();
  const match = (e.MATCH || "").trim();
  const market = (e.MARKET || "").trim().toUpperCase();
  const kickoff = (e.KICKOFF || "").trim();
  const stakePct = readStake(e.STAKE_PCT);

  if (!match) die("La rencontre est obligatoire.");

  const ko = new Date(kickoff);
  if (Number.isNaN(+ko)) die(`Coup d'envoi illisible : ${kickoff}`);
  if (+ko <= Date.now()) die("Le coup d'envoi est déjà passé. Un pari se publie avant.");

  // Combiné : LEGS contient un JSON [{comp, matchId, market, label}, ...]
  let legs = null;
  if ((e.LEGS || "").trim()) {
    try {
      legs = JSON.parse(e.LEGS);
    } catch {
      die("LEGS n'est pas un JSON valide.");
    }
    if (!Array.isArray(legs) || legs.length < 2) die("Un combiné demande au moins deux jambes.");
    for (const l of legs) {
      if (!COMPETITIONS[l.comp]) die(`Championnat inconnu dans une jambe : ${l.comp}`);
      if (!l.market) die("Chaque jambe doit porter un marché.");
      l.market = String(l.market).toUpperCase();
      l.status = "pending";
      if (l.matchId) {
        try {
          l.teams = await fetchMatch(l.matchId);
          l.match = l.teams ? `${l.teams.home.name} – ${l.teams.away.name}` : l.match || "";
        } catch (err) {
          die(err.message);
        }
      }
    }
    console.log(`Combiné à ${legs.length} jambes.`);
  } else {
    if (!COMPETITIONS[comp]) die(`Championnat inconnu : ${comp}`);
    if (!market) die("Le code du marché est obligatoire.");
  }

  const matchId = (e.MATCH_ID || "").trim() || null;
  let teams = null;
  if (!legs && matchId) {
    try {
      teams = await fetchMatch(matchId);
      if (teams) console.log(`Équipes reconnues : ${teams.home.name} – ${teams.away.name}`);
    } catch (err) {
      die(err.message);
    }
  }

  const db = await load();
  const pick = {
    id: "p" + Date.now().toString(36),
    publishedAt: new Date().toISOString(),
    comp: legs ? null : comp,
    match,
    market: legs ? null : market,
    legs,
    label: (e.LABEL || "").trim() || market || "Combiné",
    kickoff: ko.toISOString(),
    matchId: legs ? null : matchId,
    teams,
    stakePct,
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
  console.log(`Publié : ${pick.match} — ${pick.label} · mise ${(stakePct * 100).toFixed(1)} % (${pick.id})`);
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

/* -------------------------------------------------------- règlement manuel */

async function cmdManual() {
  const id = (process.env.PICK_ID || "").trim();
  const status = (process.env.STATUS || "").trim();
  if (!["won", "lost", "void"].includes(status)) die("STATUS doit valoir won, lost ou void.");

  const db = await load();
  const p = db.picks.find((x) => x.id === id);
  if (!p) die(`Pari introuvable : ${id}`);

  p.status = status;
  p.settledAt = new Date().toISOString();
  p.settledManually = true;
  delete p.needsManual;
  await save(db);
  console.log(`${p.match} réglé à la main : ${status}`);
}


/* ------------------------------------------------------- liste des matchs
   Affiche les identifiants football-data d'une journée, pour pouvoir les
   coller au moment de publier un pari. */

async function cmdFixtures() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) die("FOOTBALL_DATA_TOKEN absent des secrets du dépôt.");
  const comp = (process.env.COMP || "").trim();
  if (!COMPETITIONS[comp]) die(`Championnat inconnu : ${comp}`);

  const md = (process.env.MATCHDAY || "").trim();
  const days = Number(process.env.DAYS || 10);
  const url = md
    ? `https://api.football-data.org/v4/competitions/${comp}/matches?matchday=${md}`
    : `https://api.football-data.org/v4/competitions/${comp}/matches` +
      `?dateFrom=${new Date().toISOString().slice(0, 10)}` +
      `&dateTo=${new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)}`;

  const r = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!r.ok) die(`football-data a répondu ${r.status}`);
  const matches = (await r.json()).matches || [];
  if (!matches.length) return console.log("Aucun match sur cette période.");

  console.log(`\n${COMPETITIONS[comp]} — ${matches.length} match(s)\n`);
  console.log("match_id   | coup d'envoi (UTC)   | rencontre");
  console.log("-".repeat(72));
  for (const m of matches) {
    const h = m.homeTeam.shortName || m.homeTeam.name;
    const a = m.awayTeam.shortName || m.awayTeam.name;
    console.log(
      `${String(m.id).padEnd(10)} | ${m.utcDate.slice(0, 16).replace("T", " ")}     | ${h} – ${a}`
    );
  }
  console.log("");
}

/* ---------------------------------------------------------------- routeur */

const CMDS = { settle: cmdSettle, add: cmdAdd, odds: cmdOdds, manual: cmdManual, fixtures: cmdFixtures };
const cmd = process.argv[2];

if (!CMDS[cmd]) {
  console.error(`Commande attendue : ${Object.keys(CMDS).join(", ")}`);
  process.exit(1);
}
await CMDS[cmd]().catch((err) => die(err.message));

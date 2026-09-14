#!/usr/bin/env node
// Outil en ligne de commande de Cote à Cote.
// Aucune dépendance : Node 20+ suffit.
//
//   node scripts/cli.mjs settle    règle les rencontres terminées
//   node scripts/cli.mjs add       publie un pari (entrées via variables d'env)
//   node scripts/cli.mjs odds      enregistre des cotes
//   node scripts/cli.mjs manual    règle à la main un pari non décidable
//   node scripts/cli.mjs fixtures  liste les match_id d'une journée
//   node scripts/cli.mjs propose   sélectionne et publie via l'API Anthropic
//   node scripts/cli.mjs autoodds  relève les cotes chez The Odds API
//   node scripts/cli.mjs model     sélectionne par modèle de Poisson (sans LLM)
//   node scripts/cli.mjs veto      écarte un pari, avec raison obligatoire

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


/* ------------------------------------------------------ proposition auto
   Appelle l'API Anthropic avec le calendrier et les classements, puis publie
   les paris retenus. Tout ce que le modèle renvoie est revalidé ici : un
   identifiant inventé ou un marché inconnu est rejeté, pas publié. */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_PICKS = Number(process.env.MAX_PICKS || 5);
const VALID_MARKET = /^(1|X|2|[OU]2\.5)$/;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fd(path, token) {
  const r = await fetch(`https://api.football-data.org/v4/${path}`, {
    headers: { "X-Auth-Token": token },
  });
  if (!r.ok) throw new Error(`football-data ${path} → ${r.status}`);
  return r.json();
}

async function cmdPropose() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!token) die("FOOTBALL_DATA_TOKEN absent.");
  if (!key) die("ANTHROPIC_API_KEY absente des secrets du dépôt.");

  const codes = Object.keys(COMPETITIONS);
  const days = Number(process.env.HORIZON_DAYS || 8);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  const { matches = [] } = await fd(
    `matches?competitions=${codes.join(",")}&dateFrom=${from}&dateTo=${to}`,
    token
  );
  const upcoming = matches.filter((m) => m.status === "TIMED" || m.status === "SCHEDULED");
  if (!upcoming.length) return console.log("Aucun match programmé sur la fenêtre.");
  console.log(`${upcoming.length} match(s) sur ${days} jours.`);

  // Classements des seules compétitions concernées. 10 requêtes/min au maximum
  // sur le palier gratuit : on espace.
  const involved = [...new Set(upcoming.map((m) => m.competition.code))];
  const tables = {};
  for (const c of involved) {
    try {
      const st = await fd(`competitions/${c}/standings`, token);
      const total = (st.standings || []).find((s) => s.type === "TOTAL");
      tables[c] = (total?.table || []).map((r) =>
        `${r.position}. ${r.team.shortName || r.team.name} — ${r.points} pts, ` +
        `${r.playedGames}j, ${r.won}V ${r.draw}N ${r.lost}D, ${r.goalsFor}:${r.goalsAgainst}`
      ).join("\n");
    } catch (e) {
      console.warn(`Classement ${c} indisponible : ${e.message}`);
    }
    await wait(7000);
  }

  const fixtures = upcoming
    .map((m) =>
      `${m.id} | ${m.competition.code} | ${m.utcDate} | ` +
      `${m.homeTeam.shortName || m.homeTeam.name} – ${m.awayTeam.shortName || m.awayTeam.name}`
    )
    .join("\n");

  const prompt = `Tu sélectionnes des paris sportifs pour un suivi public dont le but est de mesurer honnêtement s'il existe un avantage face au marché.

Contraintes strictes :
- Au plus ${MAX_PICKS} paris, et moins si rien ne se détache. Ne rien proposer est une réponse valable.
- Uniquement ces marchés, les seuls dont la cote est relevable automatiquement : 1, X, 2, O2.5, U2.5.
- Pas de combinés.
- Utilise uniquement les identifiants de la liste ci-dessous.
- Ne choisis pas une rencontre uniquement parce qu'elle est prestigieuse : les gros matchs ont les marchés les plus efficients.
- Pour chaque pari, indique honnêtement ce qui pourrait le faire échouer.

Calendrier (id | compétition | date UTC | rencontre) :
${fixtures}

Classements :
${Object.entries(tables).map(([c, t]) => `--- ${COMPETITIONS[c]} ---\n${t}`).join("\n\n")}

Réponds uniquement par un tableau JSON, sans texte autour, sans balises de code :
[{"matchId":"123","market":"U2.5","label":"Moins de 2,5 buts","why":"...","caveat":"..."}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) die(`API Anthropic → ${res.status} ${await res.text()}`);

  const raw = (await res.json()).content
    .filter((b) => b.type === "text").map((b) => b.text).join("")
    .replace(/```json|```/g, "").trim();

  let proposed;
  try {
    proposed = JSON.parse(raw);
  } catch {
    die(`Réponse illisible : ${raw.slice(0, 300)}`);
  }
  if (!Array.isArray(proposed)) die("La réponse n'est pas un tableau.");

  // Revalidation : rien n'est publié sur la seule parole du modèle.
  const byId = new Map(upcoming.map((m) => [String(m.id), m]));
  const db = await load();
  const already = new Set(db.picks.map((p) => String(p.matchId)));
  let kept = 0;

  for (const c of proposed.slice(0, MAX_PICKS)) {
    const m = byId.get(String(c.matchId));
    if (!m) { console.warn(`Rejeté : identifiant ${c.matchId} hors calendrier.`); continue; }
    const market = String(c.market || "").toUpperCase();
    if (!VALID_MARKET.test(market)) { console.warn(`Rejeté : marché ${market}.`); continue; }
    if (already.has(String(m.id))) { console.warn(`Rejeté : ${m.id} déjà suivi.`); continue; }
    if (new Date(m.utcDate) <= Date.now()) { console.warn(`Rejeté : ${m.id} déjà commencé.`); continue; }

    const home = { name: m.homeTeam.shortName || m.homeTeam.name, crest: m.homeTeam.crest || null };
    const away = { name: m.awayTeam.shortName || m.awayTeam.name, crest: m.awayTeam.crest || null };
    db.picks.push({
      id: "p" + Date.now().toString(36) + kept,
      publishedAt: new Date().toISOString(),
      comp: m.competition.code,
      match: `${home.name} – ${away.name}`,
      market,
      legs: null,
      label: String(c.label || market).slice(0, 80),
      kickoff: m.utcDate,
      matchId: String(m.id),
      teams: { home, away },
      stakePct: 0.01,
      why: String(c.why || "").slice(0, 500),
      caveat: String(c.caveat || "").slice(0, 500),
      odds: null, oddsTaken: null, oddsClose: null,
      status: "pending", score: null, auto: true,
    });
    already.add(String(m.id));
    kept++;
    console.log(`Retenu : ${home.name} – ${away.name} · ${market}`);
  }

  if (!kept) return console.log("Aucun pari retenu cette semaine.");
  await save(db);
  console.log(`${kept} pari(s) publié(s).`);
}


/* ---------------------------------------------------- cotes automatiques
   The Odds API, palier gratuit. Region "eu" : Betclic, Unibet et consorts.
   Un credit par marche et par region, d'ou l'appel cible sur les seuls
   championnats ayant un pari en attente. */

const OA = "https://api.the-odds-api.com/v4";

const median = (xs) => {
  const v = xs.filter(Boolean).sort((a, b) => a - b);
  if (!v.length) return null;
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
};
const WANT_BOOKS = { betclic: "betclic_fr", unibet: "unibet_eu", winamax: "winamax_fr" };
const CLOSE_WINDOW_MIN = Number(process.env.CLOSE_WINDOW_MIN || 150);

// Indices permettant de retrouver la cle de sport, plutot que de la coder en
// dur : l'API expose la liste, autant s'y fier.
const SPORT_HINTS = {
  PL: ["epl", "premier_league"], PD: ["spain_la_liga"], BL1: ["germany_bundesliga"],
  SA: ["italy_serie_a"], FL1: ["france_ligue_one"], DED: ["netherlands_eredivisie"],
  PPL: ["portugal_primeira_liga"], ELC: ["efl_champ"], BSA: ["brazil_campeonato"],
  CL: ["uefa_champs_league"], EC: ["uefa_european_championship"], WC: ["fifa_world_cup"],
};

const norm = (s) =>
  String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(fc|ac|as|sc|cf|afc|rc|ss|us|sv|vfl|vfb|bsc|calcio|club|de|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

// Deux noms designent la meme equipe si l'un contient l'autre une fois
// normalises. Suffisant pour "Tottenham" contre "Tottenham Hotspur".
function sameTeam(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function priceFrom(bk, market, homeName, awayName) {
  const out = {};
  for (const [label, key] of Object.entries(WANT_BOOKS)) {
    const b = (bk || []).find((x) => x.key === key);
    if (!b) { out[label] = null; continue; }
    let price = null;
    const m = String(market).toUpperCase();
    const ou = m.match(/^([OU])(\d+(?:\.\d+)?)$/);
    if (ou) {
      const mk = b.markets.find((x) => x.key === "totals");
      const side = ou[1] === "O" ? "Over" : "Under";
      const line = parseFloat(ou[2]);
      const o = mk?.outcomes.find((x) => x.name === side && Number(x.point) === line);
      price = o?.price ?? null;
    } else {
      const mk = b.markets.find((x) => x.key === "h2h");
      const target = m === "1" ? homeName : m === "2" ? awayName : "Draw";
      const o = mk?.outcomes.find((x) =>
        m === "X" ? x.name === "Draw" : sameTeam(x.name, target)
      );
      price = o?.price ?? null;
    }
    out[label] = price;
  }
  return Object.values(out).some(Boolean) ? out : null;
}

async function cmdAutoOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) die("ODDS_API_KEY absente des secrets du dépôt.");

  const db = await load();
  const pending = db.picks.filter((p) => p.status === "pending" && !p.legs && p.matchId);
  if (!pending.length) return console.log("Aucun pari en attente.");

  // On ne relève que ce qui sert : cote d'ouverture manquante, ou clôture
  // imminente. Sinon on ne dépense pas de crédit.
  const need = pending.filter((p) => {
    const mins = (new Date(p.kickoff) - Date.now()) / 60000;
    if (mins <= 0) return false;
    return !p.oddsTaken || mins <= CLOSE_WINDOW_MIN;
  });
  if (!need.length) return console.log("Rien à relever pour l'instant.");

  const sports = await (await fetch(`${OA}/sports?apiKey=${key}`)).json(); // gratuit
  if (!Array.isArray(sports)) die(`Liste des sports illisible : ${JSON.stringify(sports).slice(0, 200)}`);

  const comps = [...new Set(need.map((p) => p.comp))];
  let updated = 0;

  for (const comp of comps) {
    const hints = SPORT_HINTS[comp] || [];
    const sport = sports.find((s) => hints.some((h) => s.key.includes(h)));
    if (!sport) { console.warn(`Aucune clé de sport pour ${comp}.`); continue; }

    const url =
      `${OA}/sports/${sport.key}/odds?apiKey=${key}&regions=eu` +
      `&markets=h2h,totals&oddsFormat=decimal`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`${sport.key} → ${res.status}`); continue; }
    console.log(`${sport.key} · crédits restants : ${res.headers.get("x-requests-remaining")}`);
    const events = await res.json();

    for (const p of need.filter((x) => x.comp === comp)) {
      const h = p.teams?.home?.name, a = p.teams?.away?.name;
      const ev = events.find(
        (e) => sameTeam(e.home_team, h || "") && sameTeam(e.away_team, a || "")
      );
      if (!ev) { console.warn(`Pas d'événement pour ${p.match}.`); continue; }

      const o = priceFrom(ev.bookmakers, p.market, ev.home_team, ev.away_team);
      if (!o) { console.warn(`Marché ${p.market} absent pour ${p.match}.`); continue; }

      p.odds = o;
      const mins = (new Date(p.kickoff) - Date.now()) / 60000;
      if (!p.oddsTaken) {
        p.oddsTaken = best(o);
        console.log(`${p.match} · cote du pari ${p.oddsTaken}`);
      }
      if (mins <= CLOSE_WINDOW_MIN) {
        p.oddsClose = best(o);
        console.log(`${p.match} · cote de clôture ${p.oddsClose}`);
      }
      updated++;
    }
  }

  if (updated) await save(db);
  console.log(`${updated} pari(s) mis à jour.`);
}


/* ------------------------------------------------------- modèle de Poisson
   Estime une force d'attaque et de défense par équipe à partir des buts
   marqués et encaissés, en ramenant fortement vers la moyenne du championnat
   tant que peu de matchs ont été joués. En déduit une loi de Poisson sur le
   score, donc une probabilité pour chaque issue. Ne parie que là où cette
   probabilité dépasse nettement celle qu'implique la cote. */

const PRIOR_GAMES = 6;      // poids du a priori : 6 matchs fictifs à la moyenne
const HOME_ADV = 1.12;      // multiplicateur des buts attendus à domicile
/* ====================================================================
   RÈGLE FIGÉE — déclarée le 14 septembre 2026, avant toute observation.
   NE PAS MODIFIER. Toute retouche invalide le test : une règle ajustée
   en cours de route ne mesure plus que la capacité à ajuster.

   Le backtest sur 24 389 matchs a réfuté toutes les variantes fondées sur
   l'écart de prix. Une seule n'a pas été réfutée : probabilité ≥ 70 %.
   C'est elle, et rien d'autre, qui est testée ici.

   Le tri par écart relatif est abandonné : sur une issue à 2 % de
   probabilité, une erreur de 2 points produit un écart de +100 %. Trier
   ainsi revenait à sélectionner les erreurs du modèle. Le tri se fait
   désormais par probabilité décroissante.
   ==================================================================== */
const MIN_EDGE = Number(process.env.MIN_EDGE || -1);   // aucun filtre d'écart
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.25); // plancher de cote
// Nombre de matchs joués exigé des deux équipes. En dessous, les forces
// d'attaque et de défense sont estimées sur trop peu pour valoir quoi que
// ce soit, et tout écart apparent est une erreur de modèle.
const MIN_GAMES = Number(process.env.MIN_GAMES || 8);
// Nombre de bookmakers devant coter le marché. L'écart est calculé sur le
// prix médian et non sur le meilleur : une cote isolée et généreuse crée un
// avantage fantôme, alors qu'un désaccord avec le consensus est réel.
const MIN_BOOKS = Number(process.env.MIN_BOOKS || 2);
// Dispersion maximale tolérée entre bookmakers. Au-delà, le marché lui-même
// n'est pas d'accord avec lui-même : il n'y a pas de consensus à battre.
const MAX_SPREAD = Number(process.env.MAX_SPREAD || 0.06);
// Seuil de probabilité minimale. N'améliore PAS l'espérance de gain : à
// écart égal, un pari à 70 % et un pari à 30 % rapportent autant en moyenne.
// Il réduit seulement la variance, donc les séries noires — au prix d'un
// nombre de paris plus faible, donc d'un apprentissage plus lent.
const MIN_PROB = Number(process.env.MIN_PROB || 0.70);
const MAX_GOALS = 8;

const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
const pois = (k, lambda) => (Math.exp(-lambda) * lambda ** k) / fact(k);

// Forces relatives, ramenées vers 1 proportionnellement au manque de données.
export function strengths(table) {
  const games = table.reduce((a, r) => a + r.playedGames, 0);
  const goals = table.reduce((a, r) => a + r.goalsFor, 0);
  if (!games) return null;
  const mu = goals / games; // buts par équipe et par match dans le championnat
  const out = new Map();
  for (const r of table) {
    const att = (r.goalsFor + PRIOR_GAMES * mu) / (r.playedGames + PRIOR_GAMES) / mu;
    const def = (r.goalsAgainst + PRIOR_GAMES * mu) / (r.playedGames + PRIOR_GAMES) / mu;
    out.set(r.team.id, {
      att, def, name: r.team.shortName || r.team.name, played: r.playedGames,
    });
  }
  return { mu, teams: out };
}

// Probabilités des issues, à partir des deux espérances de buts.
export function outcomes(lh, la) {
  const ph = Array.from({ length: MAX_GOALS + 1 }, (_, k) => pois(k, lh));
  const pa = Array.from({ length: MAX_GOALS + 1 }, (_, k) => pois(k, la));
  let home = 0, draw = 0, away = 0, over = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      if (i + j > 2.5) over += p;
    }
  }
  const total = home + draw + away;
  return {
    "1": home / total, X: draw / total, "2": away / total,
    "O2.5": over / total, "U2.5": 1 - over / total,
  };
}

// Second estimateur, indépendant du premier : il n'utilise que les matchs
// à domicile de l'équipe qui reçoit et ceux à l'extérieur de l'adversaire.
// Moins de données, mais pas les mêmes — c'est tout l'intérêt.
export function splitStrengths(homeTable, awayTable) {
  const build = (table, prior) => {
    const games = table.reduce((a, r) => a + r.playedGames, 0);
    const goals = table.reduce((a, r) => a + r.goalsFor, 0);
    if (!games) return null;
    const mu = goals / games;
    const map = new Map();
    for (const r of table) {
      map.set(r.team.id, {
        att: (r.goalsFor + prior * mu) / (r.playedGames + prior) / mu,
        def: (r.goalsAgainst + prior * mu) / (r.playedGames + prior) / mu,
        played: r.playedGames,
      });
    }
    return { mu, map };
  };
  const h = build(homeTable, PRIOR_GAMES / 2);
  const a = build(awayTable, PRIOR_GAMES / 2);
  return h && a ? { h, a } : null;
}

export function expectedGoalsSplit(sp, homeId, awayId) {
  const th = sp.h.map.get(homeId), ta = sp.a.map.get(awayId);
  if (!th || !ta) return null;
  return { lh: sp.h.mu * th.att * ta.def, la: sp.a.mu * ta.att * th.def };
}

export function expectedGoals(s, homeId, awayId) {
  const h = s.teams.get(homeId), a = s.teams.get(awayId);
  if (!h || !a) return null;
  return {
    lh: s.mu * h.att * a.def * HOME_ADV,
    la: s.mu * a.att * h.def / HOME_ADV,
  };
}

async function cmdModel() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  const oddsKey = process.env.ODDS_API_KEY;
  if (!token) die("FOOTBALL_DATA_TOKEN absent.");
  if (!oddsKey) die("ODDS_API_KEY absente. Le modèle ne parie que contre une cote.");

  const codes = Object.keys(COMPETITIONS);
  const days = Number(process.env.HORIZON_DAYS || 8);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  const { matches = [] } = await fd(
    `matches?competitions=${codes.join(",")}&dateFrom=${from}&dateTo=${to}`, token
  );
  const upcoming = matches.filter((m) => m.status === "TIMED" || m.status === "SCHEDULED");
  if (!upcoming.length) return console.log("Aucun match programmé.");

  const db = await load();
  const already = new Set(db.picks.map((p) => String(p.matchId)));
  const involved = [...new Set(upcoming.map((m) => m.competition.code))];
  const sports = await (await fetch(`${OA}/sports?apiKey=${oddsKey}`)).json();
  const candidates = [];
  const rejected = { games: 0, books: 0, edge: 0, prob: 0, spread: 0, disagree: 0, second: 0, odds: 0 };

  for (const comp of involved) {
    let s = null, sp = null;
    try {
      const st = await fd(`competitions/${comp}/standings`, token);
      const pick = (t) => (st.standings || []).find((x) => x.type === t)?.table || [];
      s = strengths(pick("TOTAL"));
      sp = splitStrengths(pick("HOME"), pick("AWAY"));
    } catch (e) {
      console.warn(`Classement ${comp} indisponible : ${e.message}`);
    }
    await wait(7000);
    if (!s) continue;
    if (!sp) console.warn(`${comp} : pas de découpe domicile/extérieur, second avis indisponible.`);

    const hints = SPORT_HINTS[comp] || [];
    const sport = Array.isArray(sports) && sports.find((x) => hints.some((h) => x.key.includes(h)));
    if (!sport) { console.warn(`Pas de clé de sport pour ${comp}.`); continue; }

    const res = await fetch(
      `${OA}/sports/${sport.key}/odds?apiKey=${oddsKey}&regions=eu&markets=h2h,totals&oddsFormat=decimal`
    );
    if (!res.ok) { console.warn(`Cotes ${sport.key} → ${res.status}`); continue; }
    console.log(`${sport.key} · crédits restants : ${res.headers.get("x-requests-remaining")}`);
    const events = await res.json();

    for (const m of upcoming.filter((x) => x.competition.code === comp)) {
      if (already.has(String(m.id))) continue;
      const th = s.teams.get(m.homeTeam.id), ta = s.teams.get(m.awayTeam.id);
      if (!th || !ta) continue;
      if (th.played < MIN_GAMES || ta.played < MIN_GAMES) {
        rejected.games++;
        continue;
      }
      const lam = expectedGoals(s, m.homeTeam.id, m.awayTeam.id);
      if (!lam) continue;
      const probs = outcomes(lam.lh, lam.la);

      // Second avis. Sans lui, on ne publie pas : un seul estimateur ne peut
      // pas se contredire, donc ne prouve rien.
      const lam2 = sp && expectedGoalsSplit(sp, m.homeTeam.id, m.awayTeam.id);
      if (!lam2) { rejected.second++; continue; }
      const probs2 = outcomes(lam2.lh, lam2.la);

      const hn = m.homeTeam.shortName || m.homeTeam.name;
      const an = m.awayTeam.shortName || m.awayTeam.name;
      const ev = events.find((e) => sameTeam(e.home_team, hn) && sameTeam(e.away_team, an));
      if (!ev) continue;

      for (const market of ["1", "X", "2", "O2.5", "U2.5"]) {
        const o = priceFrom(ev.bookmakers, market, ev.home_team, ev.away_team);
        if (!o) continue;
        const quotes = Object.values(o).filter(Boolean);
        if (quotes.length < MIN_BOOKS) { rejected.books++; continue; }

        const ref = median(quotes);   // consensus, sert à juger l'écart
        const price = best(o);        // meilleur prix, sert à parier

        // Les bookmakers se contredisent-ils ? Si oui, il n'y a pas de
        // consensus, donc rien à battre.
        if (price < MIN_ODDS) { rejected.odds++; continue; }

        const spread = (Math.max(...quotes) - Math.min(...quotes)) / ref;
        if (spread > MAX_SPREAD) { rejected.spread++; continue; }

        // Les deux estimateurs se contredisent-ils ? On retient le plus
        // prudent des deux, et on exige que les deux franchissent le seuil.
        const pLow = Math.min(probs[market], probs2[market]);
        const edge = pLow * ref - 1;
        const edge2 = probs2[market] * ref - 1;
        if (edge < MIN_EDGE || edge2 < MIN_EDGE) { rejected.edge++; continue; }
        if (pLow < MIN_PROB) { rejected.prob++; continue; }

        // Écart entre les deux estimateurs : au-delà de 10 points, les
        // signaux sont contradictoires et on passe son chemin.
        const gap = Math.abs(probs[market] - probs2[market]);
        if (gap > 0.10) { rejected.disagree++; continue; }

        candidates.push({
          m, comp, market, odds: o, price, ref, edge, gap,
          prob: pLow, p1: probs[market], p2: probs2[market],
          lh: lam.lh, la: lam.la, hn, an,
        });
      }
    }
  }

  // Tri par probabilité décroissante. Trier par écart relatif sélectionnait
  // les outsiders extrêmes, là où le modèle est le moins fiable : c'est
  // l'erreur que le backtest a mise en évidence (−45,8 % en validation).
  candidates.sort((a, b) => b.prob - a.prob);
  const max = Number(process.env.MAX_PICKS || 5);
  const seen = new Set();
  let kept = 0;

  for (const c of candidates) {
    if (kept >= max) break;
    if (seen.has(String(c.m.id))) continue; // un seul pari par rencontre
    seen.add(String(c.m.id));

    const LABELS = {
      "1": `${c.hn} gagne`, X: "Match nul", "2": `${c.an} gagne`,
      "O2.5": "Plus de 2,5 buts", "U2.5": "Moins de 2,5 buts",
    };
    db.picks.push({
      id: "p" + Date.now().toString(36) + kept,
      publishedAt: new Date().toISOString(),
      comp: c.comp,
      match: `${c.hn} – ${c.an}`,
      market: c.market,
      legs: null,
      label: LABELS[c.market],
      kickoff: c.m.utcDate,
      matchId: String(c.m.id),
      teams: {
        home: { name: c.hn, crest: c.m.homeTeam.crest || null },
        away: { name: c.an, crest: c.m.awayTeam.crest || null },
      },
      stakePct: 0.01,
      modelProb: Number(c.prob.toFixed(4)),
      modelEdge: Number(c.edge.toFixed(4)),
      why:
        `Le modèle attend ${c.lh.toFixed(2)} but(s) pour ${c.hn} et ` +
        `${c.la.toFixed(2)} pour ${c.an}, soit ${(c.prob * 100).toFixed(1)} % de ` +
        `chances sur ce marché. Un second estimateur, fondé uniquement sur les ` +
        `matchs à domicile et à l'extérieur, en donne ${(c.p2 * 100).toFixed(1)} % : ` +
        `les deux concordent. Le consensus des bookmakers, à ${c.ref.toFixed(2)}, ` +
        `implique ${((1 / c.ref) * 100).toFixed(1)} %. Pari pris au meilleur prix, ` +
        `${c.price.toFixed(2)}.`,
      caveat:
        "Écart calculé sur un modèle de Poisson volontairement simple, estimé " +
        "sur peu de matchs. Un écart apparent est souvent une erreur de modèle " +
        "plutôt qu'une erreur du marché.",
      odds: c.odds,
      oddsTaken: c.price,
      oddsClose: null,
      status: "pending",
      score: null,
      auto: "poisson",
    });
    kept++;
    console.log(
      `Retenu : ${c.hn} – ${c.an} · ${c.market} @ ${c.price.toFixed(2)} · ` +
      `estimateurs ${(c.p1 * 100).toFixed(1)} % et ${(c.p2 * 100).toFixed(1)} % ` +
      `(écart ${(c.gap * 100).toFixed(1)} pt) · consensus ${c.ref.toFixed(2)} · ` +
      `avantage ${(c.edge * 100).toFixed(1)} %`
    );
  }

  if (!kept) {
    return console.log(
      `Rien ne franchit les seuils.\n` +
      `  ${rejected.games} rencontre(s) : pas assez de matchs joués\n` +
      `  ${rejected.second} : second estimateur indisponible\n` +
      `  ${rejected.books} marché(s) : trop peu de bookmakers\n` +
      `  ${rejected.odds} : cote inférieure à ${MIN_ODDS}\n` +
      `  ${rejected.spread} : les bookmakers se contredisent\n` +
      `  ${rejected.edge} : écart insuffisant\n` +
      `  ${rejected.prob} : probabilité insuffisante\n` +
      `  ${rejected.disagree} : les deux estimateurs se contredisent\n` +
      `Aucune publication — c'est un résultat, pas une panne.`
    );
  }
  await save(db);
  console.log(`${kept} pari(s) publié(s).`);
}


/* ---------------------------------------------------------------- veto
   Écarte un pari sur une information que le modèle n'a pas. Le pari reste
   suivi et réglé normalement : on mesure ensuite si les vetos ont fait
   gagner ou perdre de l'argent. Un jugement qu'on ne note pas ne s'améliore
   jamais. */

const VETO_REASONS = {
  rotation: "Rotation attendue (match européen ou de coupe à proximité)",
  blessure: "Absence d'un joueur déterminant",
  entraineur: "Changement d'entraîneur récent",
  calendrier: "Calendrier congestionné",
  enjeu: "Enjeu sportif faible ou nul pour une des équipes",
  meteo: "Conditions de jeu annoncées inhabituelles",
  donnees: "Données de classement trompeuses (matchs en retard, écart de calendrier)",
};

async function cmdVeto() {
  const id = (process.env.PICK_ID || "").trim();
  const reason = (process.env.REASON || "").trim();
  const detail = (process.env.DETAIL || "").trim();

  if (!VETO_REASONS[reason]) {
    die(
      `Raison inconnue : "${reason}". Valeurs admises : ${Object.keys(VETO_REASONS).join(", ")}. ` +
      `Un veto sans raison nommable n'est pas un veto, c'est une impression.`
    );
  }
  if (detail.length < 15) {
    die("DETAIL doit décrire le fait précis, en quinze caractères au minimum.");
  }

  const db = await load();
  const p = db.picks.find((x) => x.id === id);
  if (!p) die(`Pari introuvable : ${id}`);
  if (p.status !== "pending") die("Un pari déjà réglé ne se veto pas après coup.");
  if (p.vetoed) die("Ce pari est déjà écarté.");
  if (new Date(p.kickoff) <= Date.now()) die("Le coup d'envoi est passé.");

  p.vetoed = {
    reason,
    label: VETO_REASONS[reason],
    detail: detail.slice(0, 300),
    at: new Date().toISOString(),
  };
  await save(db);
  console.log(`${p.match} écarté — ${VETO_REASONS[reason]}. Le pari reste suivi en parallèle.`);
}

/* ---------------------------------------------------------------- routeur */

const CMDS = { settle: cmdSettle, add: cmdAdd, odds: cmdOdds, manual: cmdManual, fixtures: cmdFixtures, propose: cmdPropose, autoodds: cmdAutoOdds, model: cmdModel, veto: cmdVeto };
const cmd = process.argv[2];

if (!CMDS[cmd]) {
  console.error(`Commande attendue : ${Object.keys(CMDS).join(", ")}`);
  process.exit(1);
}
await CMDS[cmd]().catch((err) => die(err.message));

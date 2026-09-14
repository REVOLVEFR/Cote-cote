// Moteur de backtest de Cote à Cote.
// Aucune dépendance. Node 20+.
//
// Principe directeur : à chaque match, le modèle ne voit que ce qui s'est
// produit AVANT. Toute fuite d'information future rendrait le résultat
// flatteur et faux — c'est l'erreur qui invalide la plupart des backtests
// de paris qu'on trouve en ligne.

/* ------------------------------------------------------------------- CSV */

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = splitLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitLine(l);
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

function splitLine(line) {
  const out = [];
  let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// football-data.co.uk : jj/mm/aa ou jj/mm/aaaa.
function parseDate(s) {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y < 100) y += y < 70 ? 2000 : 1900;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
}

const numOf = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 1 ? n : null;
};

// Les intitulés de colonnes ont changé au fil des saisons : on essaie
// plusieurs candidats plutôt que d'en coder un seul en dur.
const firstOf = (row, keys) => {
  for (const k of keys) {
    const v = numOf(row[k]);
    if (v) return v;
  }
  return null;
};

export function toMatches(rows, div) {
  const out = [];
  for (const r of rows) {
    const date = parseDate(r.Date);
    const hg = Number(r.FTHG), ag = Number(r.FTAG);
    if (!date || !r.HomeTeam || !r.AwayTeam) continue;
    if (!Number.isInteger(hg) || !Number.isInteger(ag)) continue;

    out.push({
      div: div || r.Div,
      date,
      home: r.HomeTeam,
      away: r.AwayTeam,
      hg, ag,
      // Cotes de clôture : Pinnacle en priorité, sinon la moyenne du marché.
      closeH: firstOf(r, ["PSCH", "PCH", "AvgCH", "BbAvH", "B365CH"]),
      closeD: firstOf(r, ["PSCD", "PCD", "AvgCD", "BbAvD", "B365CD"]),
      closeA: firstOf(r, ["PSCA", "PCA", "AvgCA", "BbAvA", "B365CA"]),
      // Cotes plus précoces : servent à mesurer l'écart à la clôture.
      openH: firstOf(r, ["PSH", "PH", "AvgH", "B365H"]),
      openD: firstOf(r, ["PSD", "PD", "AvgD", "B365D"]),
      openA: firstOf(r, ["PSA", "PA", "AvgA", "B365A"]),
      closeO: firstOf(r, ["PC>2.5", "AvgC>2.5", "BbAv>2.5", "B365C>2.5"]),
      closeU: firstOf(r, ["PC<2.5", "AvgC<2.5", "BbAv<2.5", "B365C<2.5"]),
      openO: firstOf(r, ["P>2.5", "Avg>2.5", "B365>2.5"]),
      openU: firstOf(r, ["P<2.5", "Avg<2.5", "B365<2.5"]),
    });
  }
  return out.sort((a, b) => a.date - b.date);
}

/* -------------------------------------------------------- dévigorisation
   La cote inclut la marge du bookmaker. La probabilité implicite brute
   surestime donc chaque issue. On ramène la somme à 1 : c'est la méthode
   proportionnelle, la plus simple. Elle suppose que la marge est répartie
   uniformément, ce qui sous-estime légèrement les favoris. La méthode de
   Shin serait plus juste ; l'écart reste faible sur les marchés liquides. */

export function devig(odds) {
  const raw = odds.map((o) => 1 / o);
  const s = raw.reduce((a, b) => a + b, 0);
  return { probs: raw.map((p) => p / s), margin: s - 1 };
}

/* ------------------------------------------------------------- le modèle */

const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
const pois = (k, l) => (Math.exp(-l) * l ** k) / fact(k);
const MAXG = 10;

// Correction de Dixon-Coles : les petits scores sont plus fréquents que ne
// le prédit l'indépendance des deux lois de Poisson. rho est fixé, non
// ajusté sur les données — l'ajuster ici reviendrait à apprendre sur le
// jeu de test.
function dc(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

export function outcomes(lh, la, rho = -0.1) {
  const ph = Array.from({ length: MAXG + 1 }, (_, k) => pois(k, lh));
  const pa = Array.from({ length: MAXG + 1 }, (_, k) => pois(k, la));
  let h = 0, d = 0, a = 0, over = 0, tot = 0;
  for (let i = 0; i <= MAXG; i++) {
    for (let j = 0; j <= MAXG; j++) {
      const p = ph[i] * pa[j] * dc(i, j, lh, la, rho);
      tot += p;
      if (i > j) h += p; else if (i === j) d += p; else a += p;
      if (i + j > 2.5) over += p;
    }
  }
  return {
    H: h / tot, D: d / tot, A: a / tot,
    O: over / tot, U: 1 - over / tot,
  };
}

/* Forces d'attaque et de défense, pondérées par l'ancienneté. Un match d'il
   y a un an pèse moitié moins qu'un match récent si HALF_LIFE vaut 365. */

export class Model {
  constructor({ halfLife = 240, prior = 8, window = 900, rho = -0.1 } = {}) {
    Object.assign(this, { halfLife, prior, window, rho });
    this.history = [];
    this.cache = null;
    this.cacheDay = null;
  }

  observe(m) {
    this.history.push(m);
    this.cache = null;
  }

  fit(asOf) {
    const day = Math.floor(asOf / 864e5);
    if (this.cache && this.cacheDay === day) return this.cache;

    const cutoff = asOf - this.window * 864e5;
    const rel = this.history.filter((m) => m.date >= cutoff && m.date < asOf);
    if (rel.length < 60) return null;

    let wSum = 0, gh = 0, ga = 0;
    const t = new Map();
    const get = (n) => {
      if (!t.has(n)) t.set(n, { hf: 0, ha: 0, hw: 0, af: 0, aa: 0, aw: 0 });
      return t.get(n);
    };

    for (const m of rel) {
      const w = Math.pow(0.5, (asOf - m.date) / 864e5 / this.halfLife);
      wSum += w; gh += w * m.hg; ga += w * m.ag;
      const H = get(m.home), A = get(m.away);
      H.hf += w * m.hg; H.ha += w * m.ag; H.hw += w;
      A.af += w * m.ag; A.aa += w * m.hg; A.aw += w;
    }
    if (wSum < 20) return null;

    const muH = gh / wSum, muA = ga / wSum;   // avantage du terrain inclus
    const pr = this.prior;
    const str = new Map();
    for (const [name, v] of t) {
      str.set(name, {
        attH: (v.hf + pr * muH) / (v.hw + pr) / muH,
        defH: (v.ha + pr * muA) / (v.hw + pr) / muA,
        attA: (v.af + pr * muA) / (v.aw + pr) / muA,
        defA: (v.aa + pr * muH) / (v.aw + pr) / muH,
        games: v.hw + v.aw,
      });
    }
    this.cache = { muH, muA, str };
    this.cacheDay = day;
    return this.cache;
  }

  predict(home, away, asOf, minGames = 8) {
    const f = this.fit(asOf);
    if (!f) return null;
    const h = f.str.get(home), a = f.str.get(away);
    if (!h || !a || h.games < minGames || a.games < minGames) return null;
    const lh = f.muH * h.attH * a.defA;
    const la = f.muA * a.attA * h.defH;
    if (!(lh > 0) || !(la > 0) || lh > 6 || la > 6) return null;
    return { ...outcomes(lh, la, this.rho), lh, la };
  }
}

/* ----------------------------------------------------------- évaluation */

const MARKETS = [
  { key: "H", close: "closeH", open: "openH", win: (m) => m.hg > m.ag },
  { key: "D", close: "closeD", open: "openD", win: (m) => m.hg === m.ag },
  { key: "A", close: "closeA", open: "openA", win: (m) => m.ag > m.hg },
  { key: "O", close: "closeO", open: "openO", win: (m) => m.hg + m.ag > 2.5 },
  { key: "U", close: "closeU", open: "openU", win: (m) => m.hg + m.ag < 2.5 },
];

// Parcourt les matchs dans l'ordre chronologique. Pour chacun : on prédit
// avec le passé seul, on enregistre, puis seulement ensuite on apprend le
// résultat.
export function backtest(matches, params = {}) {
  const { minGames = 8, minProb = 0, ...modelOpts } = params;
  const byDiv = new Map();
  const records = [];
  // Forme récente par équipe, tenue à jour au fil de l'eau. Sert à tester
  // des règles de ciblage fondées sur autre chose que l'écart de prix.
  const form = new Map();
  const getForm = (n) => {
    if (!form.has(n)) form.set(n, []);
    return form.get(n);
  };
  const last = (arr, k, f) => arr.slice(-k).reduce((a, x) => a + f(x), 0);

  for (const m of matches) {
    if (!byDiv.has(m.div)) byDiv.set(m.div, new Model(modelOpts));
    const model = byDiv.get(m.div);
    const p = model.predict(m.home, m.away, m.date, minGames);

    const fh = getForm(m.home), fa = getForm(m.away);

    if (p && fh.length >= 3 && fa.length >= 3) {
      const feat = {
        hScored3: last(fh, 3, (x) => x.gf),
        aScored3: last(fa, 3, (x) => x.gf),
        hConceded3: last(fh, 3, (x) => x.ga),
        aConceded3: last(fa, 3, (x) => x.ga),
        hPoints5: last(fh, 5, (x) => x.pts),
        aPoints5: last(fa, 5, (x) => x.pts),
      };
      const oneX2 = m.closeH && m.closeD && m.closeA
        ? devig([m.closeH, m.closeD, m.closeA]) : null;
      const ou = m.closeO && m.closeU ? devig([m.closeO, m.closeU]) : null;

      for (const mk of MARKETS) {
        const close = m[mk.close];
        if (!close) continue;
        const fair =
          mk.key === "O" ? ou?.probs[0] :
          mk.key === "U" ? ou?.probs[1] :
          oneX2?.probs["HDA".indexOf(mk.key)];
        if (!fair) continue;
        if (p[mk.key] < minProb) continue;

        records.push({
          ...feat,
          date: m.date, div: m.div, market: mk.key,
          home: m.home, away: m.away,
          model: p[mk.key],
          fair,
          edge: p[mk.key] / fair - 1,        // écart au prix équitable
          close,
          open: m[mk.open] || null,
          won: mk.win(m),
          season: seasonOf(m.date),
        });
      }
    }
    model.observe(m);
    const pt = (a, b) => (a > b ? 3 : a === b ? 1 : 0);
    fh.push({ gf: m.hg, ga: m.ag, pts: pt(m.hg, m.ag) });
    fa.push({ gf: m.ag, ga: m.hg, pts: pt(m.ag, m.hg) });
    if (fh.length > 12) fh.shift();
    if (fa.length > 12) fa.shift();
  }
  return records;
}

// Semaine ISO, pour regrouper les occasions comme le ferait une publication
// hebdomadaire.
export const weekOf = (d) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-S${String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, "0")}`;
};

// Ne garde que les N meilleures occasions de chaque semaine, comme le fait
// un bot qui publie quelques paris par week-end.
export function weeklyTop(records, n, score = (r) => r.edge) {
  const weeks = new Map();
  for (const r of records) {
    const w = weekOf(r.date);
    if (!weeks.has(w)) weeks.set(w, []);
    weeks.get(w).push(r);
  }
  const out = [];
  for (const list of weeks.values()) {
    out.push(...list.sort((a, b) => score(b) - score(a)).slice(0, n));
  }
  return out;
}

export const seasonOf = (d) => {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
};

/* Résumé d'un lot de paris. Le rendement seul ne suffit pas : on donne
   l'intervalle, l'écart à la clôture et le score de Brier. */

export function summarize(bets) {
  const n = bets.length;
  if (!n) return { n: 0 };

  const gains = bets.map((b) => (b.won ? b.close - 1 : -1));
  const units = gains.reduce((a, b) => a + b, 0);
  const roi = (units / n) * 100;
  const mu = units / n;
  const sd = Math.sqrt(gains.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, n - 1));
  const ci = 1.96 * (sd / Math.sqrt(n)) * 100;

  const withOpen = bets.filter((b) => b.open);
  const clv = withOpen.length
    ? (withOpen.reduce((a, b) => a + (b.open / b.close - 1), 0) / withOpen.length) * 100
    : null;

  // Brier : écart quadratique moyen entre probabilité annoncée et résultat.
  // Plus bas vaut mieux. On le compare à celui du marché sur les mêmes paris.
  const brier = bets.reduce((a, b) => a + (b.model - (b.won ? 1 : 0)) ** 2, 0) / n;
  const brierMkt = bets.reduce((a, b) => a + (b.fair - (b.won ? 1 : 0)) ** 2, 0) / n;

  return {
    n, units, roi, ci, clv, clvN: withOpen.length, brier, brierMkt,
    winrate: (bets.filter((b) => b.won).length / n) * 100,
    avgOdds: bets.reduce((a, b) => a + b.close, 0) / n,
    tStat: sd > 0 ? mu / (sd / Math.sqrt(n)) : 0,
  };
}

// Fiabilité : les paris annoncés à 60 % passent-ils environ 60 % du temps ?
export function calibration(bets, bins = 10) {
  const out = [];
  for (let k = 0; k < bins; k++) {
    const lo = k / bins, hi = (k + 1) / bins;
    const sub = bets.filter((b) => b.model >= lo && b.model < hi);
    if (sub.length < 20) continue;
    out.push({
      band: `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)} %`,
      n: sub.length,
      announced: (sub.reduce((a, b) => a + b.model, 0) / sub.length) * 100,
      observed: (sub.filter((b) => b.won).length / sub.length) * 100,
    });
  }
  return out;
}

/* --------------------------------------------------------- regroupements
   Leçon de l'auto-test : agréger les marchés dilue un avantage réel dans la
   sélection adverse des autres. Tout se lit marché par marché. */

export const MARKET_NAMES = {
  H: "Victoire à domicile", D: "Match nul", A: "Victoire à l'extérieur",
  O: "Plus de 2,5 buts", U: "Moins de 2,5 buts",
};

export function byMarket(records, threshold) {
  const out = {};
  for (const k of Object.keys(MARKET_NAMES)) {
    out[k] = summarize(records.filter((r) => r.market === k && r.edge >= threshold));
  }
  return out;
}

// Découpe apprentissage / validation par saison. Le seuil se choisit sur la
// première partie, et ne se juge que sur la seconde — sinon on mesure sa
// propre capacité à ajuster après coup.
export function splitSeasons(records, holdoutRatio = 0.3) {
  const seasons = [...new Set(records.map((r) => r.season))].sort();
  const cut = Math.max(1, Math.floor(seasons.length * (1 - holdoutRatio)));
  const train = new Set(seasons.slice(0, cut));
  return {
    seasons, trainSeasons: seasons.slice(0, cut), testSeasons: seasons.slice(cut),
    train: records.filter((r) => train.has(r.season)),
    test: records.filter((r) => !train.has(r.season)),
  };
}

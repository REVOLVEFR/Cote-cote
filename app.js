"use strict";

/* ------------------------------------------------------------ paramètres
   Une seule source de vérité : tous les textes et calculs en découlent. */
const CAPITAL = 1000;      // capital de départ, en euros
const BASE_STAKE = 0.01;   // mise de référence : 1 %
const MAX_STAKE = 0.02;    // plafond autorisé : 2 %

const app = document.getElementById("app");
const BOOKS = { winamax: "Winamax", betclic: "Betclic", unibet: "Unibet" };
const COMPETITIONS = {
  PL: "Premier League", PD: "Liga", BL1: "Bundesliga", SA: "Serie A",
  FL1: "Ligue 1", DED: "Eredivisie", PPL: "Liga Portugal", ELC: "Championship",
  BSA: "Brasileirão", CL: "Ligue des Champions", EC: "Championnat d'Europe",
  WC: "Coupe du Monde",
};

let DB = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const num = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const pc = (v, d = 1) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)} %`;
const eur = (v, d = 2) =>
  v === null || v === undefined ? "—" : `${Number(v).toFixed(d).replace(".", ",")} €`;
const when = (iso) =>
  new Date(iso).toLocaleString("fr-FR", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
const best = (o) => {
  const v = Object.values(o || {}).filter(Boolean);
  return v.length ? Math.max(...v) : null;
};
const avgOdds = (o) => {
  const v = Object.values(o || {}).filter(Boolean);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

const isParlay = (p) => Array.isArray(p.legs) && p.legs.length > 1;
const stakeOf = (p) => (p.stakePct || BASE_STAKE) * CAPITAL;
// Gain en unités de mise : +(cote−1) si gagné, −1 si perdu, 0 si remboursé.
const gainOf = (p) => (p.status === "won" ? (p.oddsTaken || 1) - 1 : p.status === "lost" ? -1 : 0);

async function db() {
  if (DB) return DB;
  const r = await fetch("data/picks.json", { cache: "no-store" });
  if (!r.ok) throw new Error("picks.json illisible");
  DB = await r.json();
  return DB;
}

/* ---------------------------------------------------------------- mesures */

function measures(picks) {
  const done = picks
    .filter((p) => p.status === "won" || p.status === "lost")
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  const gains = done.map(gainOf);
  const n = gains.length;
  const units = gains.reduce((a, b) => a + b, 0);
  const roi = n ? (units / n) * 100 : null;

  let ci = null;
  if (n > 1) {
    const mu = units / n;
    const v = gains.reduce((a, x) => a + (x - mu) ** 2, 0) / (n - 1);
    ci = 1.96 * Math.sqrt(v / n) * 100;
  }

  const priced = done.filter((p) => p.oddsTaken);
  const meanOdds = priced.length
    ? priced.reduce((a, p) => a + p.oddsTaken, 0) / priced.length
    : null;
  const required = priced.length
    ? (priced.reduce((a, p) => a + 1 / p.oddsTaken, 0) / priced.length) * 100
    : null;

  const clvs = picks
    .filter((p) => p.oddsTaken && p.oddsClose)
    .map((p) => (p.oddsTaken / p.oddsClose - 1) * 100);
  const clv = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;

  // Un seul parcours : capital réel (mises modulées), capital à mise fixe,
  // repli maximal et plus longue série de défaites.
  let real = CAPITAL, flat = CAPITAL, cum = 0, peak = 0, drawdown = 0;
  let streak = 0, worstStreak = 0, staked = 0;
  const bankReal = [{ i: 0, v: CAPITAL }], bankFlat = [{ i: 0, v: CAPITAL }];

  done.forEach((p, i) => {
    const g = gainOf(p);
    cum += g;
    staked += stakeOf(p);
    real += g * stakeOf(p);
    flat += g * CAPITAL * BASE_STAKE;
    bankReal.push({ i: i + 1, v: real });
    bankFlat.push({ i: i + 1, v: flat });
    peak = Math.max(peak, real);
    drawdown = Math.max(drawdown, peak - real);
    streak = p.status === "lost" ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  });

  // ROI réel (pondéré par les mises) contre ROI à mise fixe : si le premier
  // dépasse le second, la modulation de mise porte de l'information.
  const roiReal = staked ? ((real - CAPITAL) / staked) * 100 : null;

  const split = (f) => {
    const sub = done.filter(f);
    if (!sub.length) return null;
    const g = sub.map(gainOf);
    return { n: sub.length, roi: (g.reduce((a, b) => a + b, 0) / sub.length) * 100 };
  };

  return {
    n, units, roi, roiReal, ci, bankReal, bankFlat, meanOdds, drawdown, worstStreak,
    real, flat, gains,
    winrate: n ? (done.filter((p) => p.status === "won").length / n) * 100 : null,
    required, clv, clvN: clvs.length,
    beat: clvs.length ? (clvs.filter((x) => x > 0).length / clvs.length) * 100 : null,
    pending: picks.filter((p) => p.status === "pending").length,
    singles: split((p) => !isParlay(p)),
    parlays: split(isParlay),
  };
}

/* ------------------------------------------------------------ paris ouverts */

function crest(t) {
  if (!t) return "";
  return t.crest
    ? `<img class="crest" src="${esc(t.crest)}" alt="" loading="lazy" width="26" height="26">`
    : `<span class="crest crest-none" aria-hidden="true"></span>`;
}

function heading(p) {
  if (isParlay(p)) return `<h2>${esc(p.match)}</h2>`;
  if (!p.teams) return `<h2>${esc(p.match)}</h2>`;
  return `<h2 class="duel">
    <span class="side">${crest(p.teams.home)}${esc(p.teams.home.name)}</span>
    <span class="vs">contre</span>
    <span class="side">${crest(p.teams.away)}${esc(p.teams.away.name)}</span>
  </h2>`;
}

function legList(p) {
  if (!isParlay(p)) return "";
  const rows = p.legs
    .map(
      (l) => `<li>${l.teams ? crest(l.teams.home) + crest(l.teams.away) : ""}
        <span>${esc(l.match || l.matchId || "")}</span>
        <em>${esc(l.label || l.market)}</em></li>`
    )
    .join("");
  return `<ul class="legs">${rows}</ul>
    <p class="warn">Combiné à ${p.legs.length} jambes. La marge du bookmaker se
      multiplie à chaque jambe : l'espérance est nettement plus défavorable
      qu'en pariant les mêmes matchs séparément.</p>`;
}

function oddsBlock(p) {
  const stake = stakeOf(p);
  const tier = p.stakePct && p.stakePct !== BASE_STAKE
    ? ` (${(p.stakePct * 100).toFixed(1)} % du capital)`
    : "";
  if (!p.odds) {
    return `<p class="noodds">Cotes pas encore relevées. Elles sont saisies
      chez les trois opérateurs avant le coup d'envoi.</p>
      <p class="stake">Mise prévue ${eur(stake)}${tier}</p>`;
  }
  const b = best(p.odds);
  const cells = Object.keys(BOOKS)
    .map((k) => {
      const v = p.odds[k];
      return `<div class="book${v && v === b ? " best" : ""}">
        <div class="b">${BOOKS[k]}</div><div class="v num">${num(v)}</div></div>`;
    })
    .join("");
  const ret = b ? stake * b : null;
  return `<div class="books">${cells}
      <div class="book"><div class="b">Moyenne</div>
      <div class="v num">${num(avgOdds(p.odds))}</div></div></div>
    ${b ? `<p class="stake">Mise ${eur(stake)}${tier} · retour ${eur(ret)}
      si le pari passe, soit ${eur(ret - stake)} de gain net</p>` : ""}`;
}

function card(p) {
  const comp = isParlay(p) ? "Combiné" : COMPETITIONS[p.comp] || p.comp;
  return `<article class="pick">
    <div class="meta"><span class="comp">${esc(comp)}</span>
      <span>${esc(when(p.kickoff))}</span></div>
    ${heading(p)}
    <div class="bet">${esc(p.label)}</div>
    ${legList(p)}
    ${p.why ? `<p class="why">${esc(p.why)}</p>` : ""}
    ${p.caveat ? `<p class="cav">Ce qui peut le faire échouer : ${esc(p.caveat)}</p>` : ""}
    ${oddsBlock(p)}
  </article>`;
}

async function viewUpcoming() {
  const { picks } = await db();
  const s = measures(picks);
  const open = picks
    .filter((p) => p.status === "pending")
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));

  const strip = s.n
    ? `<div class="strip">
        <div><span class="k">Capital</span><span class="v num">${eur(s.real, 0)}</span></div>
        <div><span class="k">Cote moyenne</span><span class="v num">${num(s.meanOdds)}</span></div>
        <div><span class="k">Paris réglés</span><span class="v num">${s.n}</span></div>
      </div>`
    : "";

  app.innerHTML =
    `<div class="lede"><h1>Les paris ouverts</h1>
      <p>Publiés dès l'ouverture des cotes, horodatés par un commit. Capital de
         départ ${eur(CAPITAL, 0)}, mise de référence ${BASE_STAKE * 100} %
         soit ${eur(CAPITAL * BASE_STAKE, 0)}, plafonnée à
         ${MAX_STAKE * 100} %.</p></div>${strip}` +
    (open.length
      ? open.map(card).join("")
      : `<div class="empty">Aucun pari ouvert pour le moment. Les prochains
           paraissent dès que les cotes ouvrent, souvent une semaine avant.</div>`);
}

/* --------------------------------------------------------------- historique */

async function viewHistory() {
  const { picks } = await db();
  const done = picks
    .filter((p) => p.status !== "pending")
    .sort((a, b) => String(b.kickoff).localeCompare(String(a.kickoff)));

  if (!done.length) {
    app.innerHTML = `<div class="lede"><h1>Historique</h1></div>
      <div class="empty">Aucun pari réglé pour l'instant.</div>`;
    return;
  }

  const rows = done
    .map((p) => {
      const tag = { won: ["Gagné", "t-won"], lost: ["Perdu", "t-lost"], void: ["Remboursé", "t-void"] }[p.status];
      const g = gainOf(p);
      const clv = p.oddsTaken && p.oddsClose ? (p.oddsTaken / p.oddsClose - 1) * 100 : null;
      const name = p.teams ? `${p.teams.home.name} – ${p.teams.away.name}` : p.match;
      const comp = isParlay(p) ? `Combiné ${p.legs.length} jambes` : COMPETITIONS[p.comp] || p.comp;
      return `<tr>
        <td>${!isParlay(p) && p.teams ? crest(p.teams.home) + crest(p.teams.away) : ""}${esc(name)}
          <div class="sub">${esc(comp)} · ${esc(p.label)}${p.score ? ` · ${esc(p.score)}` : ""}</div></td>
        <td class="r num hide-s">${num(p.oddsTaken)}</td>
        <td class="r num hide-s">${clv === null ? "—" : pc(clv)}</td>
        <td class="r num">${g > 0 ? "+" : ""}${eur(g * stakeOf(p))}</td>
        <td class="r"><span class="tag ${tag[1]}">${tag[0]}</span></td>
      </tr>`;
    })
    .join("");

  app.innerHTML = `<div class="lede"><h1>Historique</h1>
      <p>Tous les paris réglés, sans filtre. Le règlement est automatique
         à la fin de la rencontre.</p></div>
    <table><thead><tr><th>Rencontre</th><th class="r hide-s">Cote</th>
      <th class="r hide-s">Écart clôture</th><th class="r">Résultat</th>
      <th class="r">Issue</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* -------------------------------------------------------------------- bilan */

function rangeBar(roi, ci) {
  if (roi === null) return "";
  const lo = ci === null ? roi : roi - ci;
  const hi = ci === null ? roi : roi + ci;
  const b = Math.max(40, Math.abs(lo), Math.abs(hi)) * 1.15;
  const x = (v) => ((v + b) / (2 * b)) * 100;
  return `<div class="range">
    <div class="cap"><span>Rendement et sa marge d'erreur à 95 %</span>
      <span class="num">${pc(roi)} · [${num(lo, 1)} ; ${num(hi, 1)}]</span></div>
    <div class="track"><div class="zero"></div>
      <div class="span" style="left:${x(lo)}%;width:${x(hi) - x(lo)}%"></div>
      <div class="dot" style="left:${x(roi)}%"></div></div>
    <div class="ticks num"><span>−${b.toFixed(0)} %</span><span>0</span>
      <span>+${b.toFixed(0)} %</span></div>
    <p class="note">Tant que la barre traverse le zéro, ce résultat reste
      compatible avec l'absence totale d'avantage.</p></div>`;
}

function bankChart(real, flat) {
  if (real.length < 2) {
    return `<div class="empty">Le capital évoluera dès le premier pari réglé.</div>`;
  }
  const W = 700, H = 220, L = 52, R = 12, T = 14, B = 20;
  const vals = real.concat(flat).map((p) => p.v).concat([CAPITAL]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(5, (hi - lo) * 0.18);
  const y = (v) => T + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - T - B);
  const x = (i) => L + (i / Math.max(1, real.length - 1)) * (W - L - R);
  const path = (pts) => pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const marks = [hi + pad, CAPITAL, lo - pad]
    .map((v) => `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end"
      font-size="11" fill="#6E6E76">${v.toFixed(0)} €</text>`)
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="Évolution du capital">
    <line x1="${L}" y1="${y(CAPITAL)}" x2="${W - R}" y2="${y(CAPITAL)}"
      stroke="#C9C9C2" stroke-width="1" stroke-dasharray="4 4"/>
    ${marks}
    <polyline points="${path(flat)}" fill="none" stroke="#6E6E76"
      stroke-width="1.3" stroke-dasharray="5 3"/>
    <polyline points="${path(real)}" fill="none" stroke="#1D4E4A"
      stroke-width="2" stroke-linejoin="round"/>
  </svg>
  <p class="legend"><span class="sw sw-flat"></span>Mises réelles
    <span class="sw sw-comp"></span>Mise fixe de ${BASE_STAKE * 100} %</p>`;
}

async function viewRecord() {
  const { picks } = await db();
  const s = measures(picks);
  const v =
    s.n === 0
      ? ["Aucun pari réglé",
         "Les mesures apparaîtront dès que des rencontres auront été jouées."]
      : s.n < 400
      ? [`Non concluant — ${s.n} paris réglés`,
         "À cette taille d'échantillon, le rendement ne distingue pas un avantage réel du hasard. Il faudrait environ 1 600 paris pour resserrer la marge d'erreur à cinq points. L'écart à la cote de clôture, lui, devient lisible vers 150 paris."]
      : [`Lecture possible — ${s.n} paris réglés`,
         "L'échantillon commence à porter de l'information. L'écart à la clôture reste le juge de paix."];

  const compare =
    s.roiReal !== null && s.roi !== null
      ? `<p class="note">Rendement aux mises réelles : <strong>${pc(s.roiReal)}</strong>.
         À mise fixe de ${BASE_STAKE * 100} % il aurait été de <strong>${pc(s.roi)}</strong>.
         Si le premier ne dépasse pas durablement le second, moduler la mise selon
         la confiance n'apporte rien et il faut revenir à la mise fixe.</p>`
      : "";

  const kinds =
    s.singles && s.parlays
      ? `<div class="sec"><h3>Simples contre combinés</h3>
          <table><thead><tr><th>Type</th><th class="r">Paris</th>
            <th class="r">Rendement</th></tr></thead><tbody>
            <tr><td>Paris simples</td><td class="r num">${s.singles.n}</td>
              <td class="r num">${pc(s.singles.roi)}</td></tr>
            <tr><td>Combinés</td><td class="r num">${s.parlays.n}</td>
              <td class="r num">${pc(s.parlays.roi)}</td></tr>
          </tbody></table>
          <p class="note">La marge du bookmaker se multiplie à chaque jambe : à
            5 % de marge par match, un combiné à trois jambes porte une espérance
            de −14,3 %. Ce tableau existe pour vérifier ce calcul sur tes données.</p>
        </div>`
      : "";

  app.innerHTML = `<div class="lede"><h1>Bilan</h1>
      <p>Ce que les chiffres autorisent à conclure — et ce qu'ils n'autorisent pas.</p></div>
    <div class="verdict"><h2>${esc(v[0])}</h2><p>${esc(v[1])}</p></div>

    <div class="sec"><h3>Un capital de ${eur(CAPITAL, 0)}, pari après pari</h3>
      ${bankChart(s.bankReal, s.bankFlat)}${compare}
    </div>

    ${rangeBar(s.roi, s.ci)}

    <div class="kpis">
      <div class="kpi"><div class="k">Écart à la cote de clôture</div>
        <div class="v num">${pc(s.clv)}</div>
        <div class="s">${s.clvN ? `${s.clvN} paris cotés · ${num(s.beat, 0)} % au-dessus` : "en attente de relevés"}</div></div>
      <div class="kpi"><div class="k">Capital</div>
        <div class="v num">${eur(s.real, 0)}</div>
        <div class="s">départ ${eur(CAPITAL, 0)}</div></div>
      <div class="kpi"><div class="k">Cote moyenne</div>
        <div class="v num">${num(s.meanOdds)}</div>
        <div class="s">${s.required === null ? "sur les paris réglés" : `seuil de rentabilité ${num(s.required, 1)} %`}</div></div>
      <div class="kpi"><div class="k">Taux de réussite</div>
        <div class="v num">${s.winrate === null ? "—" : num(s.winrate, 1) + " %"}</div>
        <div class="s">à comparer au seuil ci-contre</div></div>
      <div class="kpi"><div class="k">Repli maximal</div>
        <div class="v num">${s.n ? eur(s.drawdown, 0) : "—"}</div>
        <div class="s">pire creux depuis un sommet</div></div>
      <div class="kpi"><div class="k">Série noire</div>
        <div class="v num">${s.n ? s.worstStreak : "—"}</div>
        <div class="s">défaites consécutives</div></div>
      <div class="kpi"><div class="k">Bilan cumulé</div>
        <div class="v num">${s.n ? (s.units > 0 ? "+" : "") + num(s.units) + " u" : "—"}</div>
        <div class="s">en unités de mise</div></div>
      <div class="kpi"><div class="k">Paris ouverts</div>
        <div class="v num">${s.pending}</div>
        <div class="s">rencontres non jouées</div></div>
    </div>
    ${kinds}`;
}

/* --------------------------------------------------------------- projection
   Deux régimes. Avec assez de paris réglés, on projette par rééchantillonnage
   des résultats observés — ce qui propage l'incertitude au lieu de la masquer.
   Sinon, on retombe sur une hypothèse explicite. */

const MIN_FOR_BOOTSTRAP = 10;

function pickFrom(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

// Rendement nécessaire pour passer du capital de départ à l'objectif.
function requiredRoi(target, bets, stakePct) {
  return ((target - CAPITAL) / (bets * CAPITAL * stakePct)) * 100;
}

function project({ bets, stakePct, target, gains, edge, odds, runs = 1200 }) {
  const stake = CAPITAL * stakePct;
  const steps = Math.min(bets, 40);
  const every = bets / steps;
  const checkpoints = Array.from({ length: steps + 1 }, (_, k) => Math.round(k * every));
  const grid = checkpoints.map(() => new Float64Array(runs));
  const p = gains ? null : (1 + edge) / odds;
  const win = gains ? null : stake * (odds - 1);

  for (let r = 0; r < runs; r++) {
    // Bootstrap à deux étages : on tire d'abord un échantillon plausible de
    // l'historique, puis on tire l'avenir dedans. Le premier étage porte
    // l'incertitude sur l'avantage, le second celle des résultats.
    const pseudo = gains ? Array.from({ length: gains.length }, () => pickFrom(gains)) : null;
    let bank = CAPITAL, c = 0;
    grid[0][r] = CAPITAL;
    for (let i = 1; i <= bets; i++) {
      bank += pseudo
        ? pickFrom(pseudo) * stake
        : Math.random() < p ? win : -stake;
      if (i === checkpoints[c + 1]) grid[++c][r] = bank;
    }
  }

  const quant = (col, q) => {
    const t = Float64Array.from(col).sort();
    return t[Math.min(t.length - 1, Math.floor(q * t.length))];
  };
  const band = grid.map((col, k) => ({
    i: checkpoints[k], p5: quant(col, 0.05), p50: quant(col, 0.5), p95: quant(col, 0.95),
  }));
  const last = Array.from(grid[grid.length - 1]);
  return {
    band,
    final: band[band.length - 1],
    above: last.filter((v) => v > CAPITAL).length / runs,
    reach: last.filter((v) => v >= target).length / runs,
  };
}

function fanChart(band, target) {
  const W = 700, H = 250, L = 58, R = 12, T = 14, B = 24;
  const vals = band.flatMap((b) => [b.p5, b.p95]).concat([CAPITAL, target]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || 50;
  const y = (v) => T + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - T - B);
  const maxI = band[band.length - 1].i;
  const x = (i) => L + (i / maxI) * (W - L - R);
  const area =
    band.map((b) => `${x(b.i).toFixed(1)},${y(b.p95).toFixed(1)}`).join(" ") + " " +
    band.slice().reverse().map((b) => `${x(b.i).toFixed(1)},${y(b.p5).toFixed(1)}`).join(" ");
  const median = band.map((b) => `${x(b.i).toFixed(1)},${y(b.p50).toFixed(1)}`).join(" ");
  const marks = [hi + pad, CAPITAL, lo - pad]
    .map((v) => `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end"
      font-size="11" fill="#6E6E76">${v.toFixed(0)} €</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="Projection du capital, fourchette à 90 %">
    <polygon points="${area}" fill="rgba(29,78,74,.13)"/>
    <line x1="${L}" y1="${y(CAPITAL)}" x2="${W - R}" y2="${y(CAPITAL)}"
      stroke="#16161A" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${L}" y1="${y(target)}" x2="${W - R}" y2="${y(target)}"
      stroke="#1D4E4A" stroke-width="1.2"/>
    <text x="${W - R}" y="${y(target) - 6}" text-anchor="end" font-size="11"
      fill="#1D4E4A">objectif ${target} €</text>
    ${marks}
    <polyline points="${median}" fill="none" stroke="#1D4E4A" stroke-width="2"/>
    <text x="${L}" y="${H - 6}" font-size="11" fill="#6E6E76">0</text>
    <text x="${W - R}" y="${H - 6}" font-size="11" fill="#6E6E76"
      text-anchor="end">${maxI} paris</text>
  </svg>`;
}

let PROJ_STATS = null;

function drawProjection() {
  const val = (id) => Number(document.getElementById(id).value);
  const bets = val("pj-bets");
  const target = val("pj-target");
  const stakePct = val("pj-stake") / 100;
  const mode = document.getElementById("pj-mode").value;

  const useResults = mode === "results" && PROJ_STATS.n >= MIN_FOR_BOOTSTRAP;
  const r = project({
    bets, stakePct, target,
    gains: useResults ? PROJ_STATS.gains : null,
    edge: mode === "results" ? -0.05 : Number(mode) / 100,
    odds: PROJ_STATS.meanOdds || 2,
  });

  const need = requiredRoi(target, bets, stakePct);
  const verdict =
    need <= 5
      ? "C'est dans l'ordre de grandeur de ce qu'atteignent les meilleurs parieurs professionnels sur la durée."
      : need <= 15
      ? "Nettement au-dessus de ce que réalisent les parieurs professionnels réguliers. Atteignable ponctuellement par chance, pas durablement."
      : "Hors de portée d'un avantage réel. Un tel rendement sur cette durée relèverait du coup de chance, pas de la méthode.";

  document.getElementById("pj-need").innerHTML = `
    <div class="verdict"><h2>Il faudrait un rendement de ${pc(need)}</h2>
      <p>Pour passer de ${eur(CAPITAL, 0)} à ${eur(target, 0)} en ${bets} paris
         à ${(stakePct * 100).toFixed(0)} % de mise. ${verdict}</p></div>`;

  document.getElementById("pj-source").textContent = useResults
    ? `Projection tirée des ${PROJ_STATS.n} paris déjà réglés, par rééchantillonnage.`
    : mode === "results"
    ? `Pas encore assez de paris réglés (${PROJ_STATS.n} sur ${MIN_FOR_BOOTSTRAP} nécessaires). Affichage sur l'hypothèse par défaut : la marge du bookmaker.`
    : `Projection sur hypothèse choisie, sans lien avec les résultats réels.`;

  document.getElementById("pj-chart").innerHTML = fanChart(r.band, target);
  document.getElementById("pj-out").innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="k">Probabilité d'atteindre l'objectif</div>
        <div class="v num">${(r.reach * 100).toFixed(0)} %</div>
        <div class="s">${eur(target, 0)} après ${bets} paris</div></div>
      <div class="kpi"><div class="k">Scénario médian</div>
        <div class="v num">${eur(r.final.p50, 0)}</div>
        <div class="s">la moitié des trajectoires font mieux</div></div>
      <div class="kpi"><div class="k">Fourchette à 90 %</div>
        <div class="v num">${eur(r.final.p5, 0)} – ${eur(r.final.p95, 0)}</div>
        <div class="s">9 scénarios sur 10</div></div>
      <div class="kpi"><div class="k">Probabilité d'être gagnant</div>
        <div class="v num">${(r.above * 100).toFixed(0)} %</div>
        <div class="s">au-dessus de ${eur(CAPITAL, 0)}</div></div>
    </div>`;
}

async function viewProjection() {
  const { picks } = await db();
  PROJ_STATS = measures(picks);

  app.innerHTML = `<div class="lede"><h1>Projection</h1>
      <p>Fixe un objectif et un horizon : le site calcule le rendement qu'il
         faudrait tenir, puis simule 1 200 trajectoires à partir des résultats
         déjà obtenus.</p></div>

    <div class="controls">
      <div><label for="pj-target">Objectif</label>
        <select id="pj-target"><option value="1200">1 200 €</option>
          <option value="1500" selected>1 500 €</option>
          <option value="2000">2 000 €</option>
          <option value="3000">3 000 €</option></select></div>
      <div><label for="pj-bets">Horizon</label>
        <select id="pj-bets"><option>100</option><option selected>200</option>
          <option>500</option><option>1000</option></select></div>
      <div><label for="pj-stake">Mise</label>
        <select id="pj-stake"><option value="1" selected>1 %</option>
          <option value="2">2 %</option></select></div>
      <div><label for="pj-mode">Base de calcul</label>
        <select id="pj-mode">
          <option value="results" selected>Mes résultats réels</option>
          <option value="-5">Hypothèse : −5 % (marge du bookmaker)</option>
          <option value="0">Hypothèse : 0 %</option>
          <option value="3">Hypothèse : +3 %</option>
        </select></div>
    </div>

    <div id="pj-need"></div>
    <div id="pj-chart" class="sec"></div>
    <div id="pj-out"></div>
    <p class="note" id="pj-source"></p>
    <p class="note">La bande couvre 90 % des trajectoires, la ligne pleine est le
      scénario médian. Plus le nombre de paris réglés est faible, plus la bande
      est large : c'est l'incertitude réelle, pas un défaut d'affichage.</p>
    <p class="note">Le rendement requis est de l'arithmétique, pas une prévision :
      doubler ${eur(CAPITAL, 0)} en 200 paris à 1 % de mise exige +50 % de
      rendement, quand les parieurs professionnels réguliers évoluent plutôt
      entre +2 et +5 %.</p>`;

  ["pj-target", "pj-bets", "pj-stake", "pj-mode"].forEach((id) =>
    document.getElementById(id).addEventListener("change", drawProjection)
  );
  drawProjection();
}

/* ------------------------------------------------------------------ routeur */

const VIEWS = {
  upcoming: viewUpcoming, history: viewHistory,
  record: viewRecord, projection: viewProjection,
};

function go(name) {
  document.querySelectorAll(".top nav button").forEach((b) =>
    b.classList.toggle("on", b.dataset.go === name)
  );
  app.innerHTML = `<p class="loading">Chargement…</p>`;
  VIEWS[name]().catch(
    () =>
      (app.innerHTML = `<div class="empty">Les données n'ont pas pu être chargées.
        Recharge la page.</div>`)
  );
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-go]");
  if (!el) return;
  e.preventDefault();
  go(el.dataset.go);
});

go("upcoming");

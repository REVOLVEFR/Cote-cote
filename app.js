"use strict";

const app = document.getElementById("app");
const BOOKS = { winamax: "Winamax", betclic: "Betclic", unibet: "Unibet" };
const COMPETITIONS = {
  PL: "Premier League", PD: "Liga", BL1: "Bundesliga", SA: "Serie A",
  FL1: "Ligue 1", DED: "Eredivisie", PPL: "Liga Portugal",
};

const CAPITAL = 1000;   // capital de départ, en euros
const STAKE = 0.01;    // 1 % — mise fixe de 1 € par pari

let DB = null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const num = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const pc = (v, d = 1) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)} %`;
const eur = (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(2)} €`);
const when = (iso) =>
  new Date(iso).toLocaleString("fr-FR", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
const best = (o) => {
  const v = Object.values(o || {}).filter(Boolean);
  return v.length ? Math.max(...v) : null;
};
const avg = (o) => {
  const v = Object.values(o || {}).filter(Boolean);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
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
  const avgOdds = priced.length
    ? priced.reduce((a, p) => a + p.oddsTaken, 0) / priced.length
    : null;
  const required = priced.length
    ? (priced.reduce((a, p) => a + 1 / p.oddsTaken, 0) / priced.length) * 100
    : null;

  const clvs = picks
    .filter((p) => p.oddsTaken && p.oddsClose)
    .map((p) => (p.oddsTaken / p.oddsClose - 1) * 100);
  const clv = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;

  // Un seul parcours : courbe en unités, capital à mise fixe, capital composé,
  // repli maximal et plus longue série de défaites.
  let cum = 0, flat = CAPITAL, comp = CAPITAL, peak = 0, drawdown = 0;
  let streak = 0, worstStreak = 0;
  const curve = [], bankFlat = [{ i: 0, v: CAPITAL }], bankComp = [{ i: 0, v: CAPITAL }];

  done.forEach((p, i) => {
    const g = gainOf(p);
    cum += g;
    curve.push({ i: i + 1, v: cum });

    flat += g * CAPITAL * STAKE;
    comp += g * comp * STAKE;
    bankFlat.push({ i: i + 1, v: flat });
    bankComp.push({ i: i + 1, v: comp });

    peak = Math.max(peak, cum);
    drawdown = Math.max(drawdown, peak - cum);
    streak = p.status === "lost" ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  });

  return {
    n, units, roi, ci, curve, bankFlat, bankComp, avgOdds, drawdown, worstStreak,
    flat, comp,
    winrate: n ? (done.filter((p) => p.status === "won").length / n) * 100 : null,
    required, clv, clvN: clvs.length,
    beat: clvs.length ? (clvs.filter((x) => x > 0).length / clvs.length) * 100 : null,
    pending: picks.filter((p) => p.status === "pending").length,
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
  if (!p.teams) return `<h2>${esc(p.match)}</h2>`;
  return `<h2 class="duel">
    <span class="side">${crest(p.teams.home)}${esc(p.teams.home.name)}</span>
    <span class="vs">contre</span>
    <span class="side">${crest(p.teams.away)}${esc(p.teams.away.name)}</span>
  </h2>`;
}

function oddsBlock(p) {
  if (!p.odds) {
    return `<p class="noodds">Cotes pas encore relevées. Elles sont saisies
      chez les trois opérateurs avant le coup d'envoi.</p>`;
  }
  const b = best(p.odds);
  const cells = Object.keys(BOOKS)
    .map((k) => {
      const v = p.odds[k];
      return `<div class="book${v && v === b ? " best" : ""}">
        <div class="b">${BOOKS[k]}</div><div class="v num">${num(v)}</div></div>`;
    })
    .join("");
  const stake = CAPITAL * STAKE;
  const ret = b ? stake * b : null;
  return `<div class="books">${cells}
      <div class="book"><div class="b">Moyenne</div>
      <div class="v num">${num(avg(p.odds))}</div></div></div>
    ${b ? `<p class="stake">Mise conseillée ${eur(stake)} · retour ${eur(ret)}
      si le pari passe, soit ${eur(ret - stake)} de gain net</p>` : ""}`;
}

function card(p) {
  return `<article class="pick">
    <div class="meta"><span class="comp">${esc(COMPETITIONS[p.comp] || p.comp)}</span>
      <span>${esc(when(p.kickoff))}</span></div>
    ${heading(p)}
    <div class="bet">${esc(p.label)}</div>
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
        <div><span class="k">Capital</span><span class="v num">${eur(s.flat)}</span></div>
        <div><span class="k">Cote moyenne</span><span class="v num">${num(s.avgOdds)}</span></div>
        <div><span class="k">Paris réglés</span><span class="v num">${s.n}</span></div>
      </div>`
    : "";

  app.innerHTML =
    `<div class="lede"><h1>Les paris ouverts</h1>
      <p>Publiés avant le coup d'envoi et horodatés par un commit. Mise fixe de
         1 € par pari, sur un capital de départ de 100 €.</p></div>${strip}` +
    (open.length
      ? open.map(card).join("")
      : `<div class="empty">Aucun pari ouvert pour le moment. Les prochains
           paraîtront la veille de la journée de championnat.</div>`);
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
      return `<tr>
        <td>${p.teams ? crest(p.teams.home) + crest(p.teams.away) : ""}${esc(name)}
          <div class="sub">${esc(COMPETITIONS[p.comp] || p.comp)} ·
          ${esc(p.label)}${p.score ? ` · ${esc(p.score)}` : ""}</div></td>
        <td class="r num hide-s">${num(p.oddsTaken)}</td>
        <td class="r num hide-s">${clv === null ? "—" : pc(clv)}</td>
        <td class="r num">${g > 0 ? "+" : ""}${eur(g * CAPITAL * STAKE)}</td>
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

// Capital : mise fixe en trait plein, mise composée en pointillé,
// ligne de référence à 100 €.
function bankChart(flat, comp) {
  if (flat.length < 2) {
    return `<div class="empty">Le capital évoluera dès le premier pari réglé.</div>`;
  }
  const W = 700, H = 220, L = 46, R = 12, T = 14, B = 20;
  const vals = flat.concat(comp).map((p) => p.v).concat([CAPITAL]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(2, (hi - lo) * 0.18);
  const y = (v) => T + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - T - B);
  const x = (i) => L + (i / Math.max(1, flat.length - 1)) * (W - L - R);
  const path = (pts) => pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const marks = [hi + pad, CAPITAL, lo - pad]
    .map(
      (v) => `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end"
        font-size="11" fill="#6E6E76">${v.toFixed(0)} €</text>`
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="Évolution d'un capital de 100 euros">
    <line x1="${L}" y1="${y(CAPITAL)}" x2="${W - R}" y2="${y(CAPITAL)}"
      stroke="#C9C9C2" stroke-width="1" stroke-dasharray="4 4"/>
    ${marks}
    <polyline points="${path(comp)}" fill="none" stroke="#6E6E76"
      stroke-width="1.3" stroke-dasharray="5 3"/>
    <polyline points="${path(flat)}" fill="none" stroke="#1D4E4A"
      stroke-width="2" stroke-linejoin="round"/>
  </svg>
  <p class="legend"><span class="sw sw-flat"></span>Mise fixe de 1 €
    <span class="sw sw-comp"></span>Mise de 1 % du capital courant</p>`;
}

function curveSvg(pts) {
  if (!pts.length) return `<div class="empty">La courbe apparaît au premier pari réglé.</div>`;
  const W = 700, H = 170, P = 14;
  const vals = pts.map((p) => p.v).concat([0]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(1, (hi - lo) * 0.15);
  const y = (v) => P + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - 2 * P);
  const x = (i) => P + ((i - 1) / Math.max(1, pts.length - 1)) * (W - 2 * P);
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
      aria-label="Bilan cumulé en unités">
    <line x1="${P}" y1="${y(0)}" x2="${W - P}" y2="${y(0)}" stroke="#E5E5DF"
      stroke-width="1" stroke-dasharray="4 4"/>
    <polyline points="${line}" fill="none" stroke="#16161A" stroke-width="1.8"
      stroke-linejoin="round"/></svg>`;
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

  app.innerHTML = `<div class="lede"><h1>Bilan</h1>
      <p>Ce que les chiffres autorisent à conclure — et ce qu'ils n'autorisent pas.</p></div>
    <div class="verdict"><h2>${esc(v[0])}</h2><p>${esc(v[1])}</p></div>

    <div class="sec"><h3>Un capital de 100 €, pari après pari</h3>
      ${bankChart(s.bankFlat, s.bankComp)}
      <p class="note">Mise fixe de 1 € par pari, soit 1 % du capital de départ.
        Cette fraction n'est pas un dimensionnement optimal : tant que l'avantage
        n'est pas mesuré, elle sert à tenir cent paris sans risquer le capital.</p>
    </div>

    ${rangeBar(s.roi, s.ci)}

    <div class="kpis">
      <div class="kpi"><div class="k">Écart à la cote de clôture</div>
        <div class="v num">${pc(s.clv)}</div>
        <div class="s">${s.clvN ? `${s.clvN} paris cotés · ${num(s.beat, 0)} % au-dessus` : "en attente de relevés"}</div></div>
      <div class="kpi"><div class="k">Capital</div>
        <div class="v num">${eur(s.flat)}</div>
        <div class="s">départ 100 €</div></div>
      <div class="kpi"><div class="k">Cote moyenne</div>
        <div class="v num">${num(s.avgOdds)}</div>
        <div class="s">sur les paris réglés</div></div>
      <div class="kpi"><div class="k">Taux de réussite</div>
        <div class="v num">${s.winrate === null ? "—" : num(s.winrate, 1) + " %"}</div>
        <div class="s">${s.required === null ? "—" : `seuil de rentabilité ${num(s.required, 1)} %`}</div></div>
      <div class="kpi"><div class="k">Repli maximal</div>
        <div class="v num">${s.n ? eur(s.drawdown * CAPITAL * STAKE) : "—"}</div>
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

    <p class="note">Un taux de réussite ne veut rien dire seul : à cote 1,28 il faut
      78,1 % pour être à l'équilibre. Il est toujours affiché ici avec son seuil.</p>

    <div class="sec"><h3>Bilan cumulé en unités</h3>${curveSvg(s.curve)}</div>`;
}

/* ------------------------------------------------------------------ routeur */

const VIEWS = { upcoming: viewUpcoming, history: viewHistory, record: viewRecord };

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

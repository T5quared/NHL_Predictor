// Pure maths for props — no network. Tested in test/props.test.js.
const { BLEND, FILTERS } = require('./config');

const americanToProb = a => {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
};
const probToAmerican = p => {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
};
// Remove the vig from a two-sided price
function devig(overOdds, underOdds) {
  const o = americanToProb(overOdds), u = americanToProb(underOdds);
  if (o == null) return null;
  if (u == null) return o;
  return o / (o + u);
}

function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return Math.min(1, sum);
}
// P(stat beats line). Half lines only in practice; whole lines treat a push as a loss here.
function poissonSideProb(lambda, line, side) {
  if (side === 'over') return 1 - poissonCdf(Math.floor(line), lambda);
  return poissonCdf(Math.ceil(line) - 1, lambda);
}

// Hit counts for one window. values = stat per game, newest first. Pushes are left out.
function hitWindow(values, line, side, n) {
  const games = n == null ? values : values.slice(0, n);
  let hits = 0, count = 0;
  for (const v of games) {
    if (v === line) continue;
    count++;
    if (side === 'over' ? v > line : v < line) hits++;
  }
  return { hits, n: count, pct: count ? hits / count : null };
}
function hitRates(values, line, side) {
  return {
    l5: hitWindow(values, line, side, 5),
    l10: hitWindow(values, line, side, 10),
    l25: hitWindow(values, line, side, 25),
    season: hitWindow(values, line, side, null),
  };
}

// Weighted window blend, then pulled toward `prior` (the market price) on small samples
function blendedHitRate(rates, prior) {
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(BLEND.WINDOW_WEIGHTS)) {
    if (rates[k]?.pct == null) continue;
    sum += w * rates[k].pct; wsum += w;
  }
  if (!wsum) return { raw: null, shrunk: prior ?? null };
  const raw = sum / wsum;
  const n = rates.season.n, K = BLEND.HIT_SHRINK_GAMES;
  const shrunk = prior == null ? raw : (raw * n + prior * K) / (n + K);
  return { raw, shrunk };
}

// Combine model + hit rate, compare to the market, apply the Top-pick filters
function scoreProp({ modelProb, rates, implied, bookOdds, gamesPlayed, books = null }) {
  const hit = blendedHitRate(rates, implied ?? modelProb);
  const finalProb = BLEND.MODEL_WEIGHT * modelProb + BLEND.HIT_WEIGHT * hit.shrunk;
  const edge = implied == null ? null : finalProb - implied;
  const ref = implied ?? 0.5;
  const consistent = ['l10', 'l25', 'season'].every(k => rates[k].pct != null && rates[k].pct > ref);
  // No market price: check the price range against the model's own fair odds instead
  const odds = bookOdds == null ? probToAmerican(finalProb) : Number(bookOdds);
  const reasons = [];
  if (gamesPlayed < FILTERS.MIN_GAMES) reasons.push('games');
  if (bookOdds != null && books != null && books < FILTERS.MIN_BOOKS) reasons.push('books');
  if (finalProb < FILTERS.MIN_FINAL_PROB) reasons.push('prob');
  if (edge != null && edge < FILTERS.MIN_EDGE) reasons.push('edge');
  if (Number.isFinite(odds) && (odds < FILTERS.MIN_ODDS || odds > FILTERS.MAX_ODDS)) reasons.push('odds');
  return {
    hitRaw: hit.raw, hitShrunk: hit.shrunk, finalProb, edge, consistent,
    fairOddsModel: probToAmerican(finalProb), topPick: reasons.length === 0, failed: reasons,
  };
}

// Rank: edge when there is a market price, otherwise final probability
function rankProps(props) {
  return [...props].sort((a, b) => {
    if (a.topPick !== b.topPick) return a.topPick ? -1 : 1;
    const ka = a.edge ?? a.finalProb - 0.5, kb = b.edge ?? b.finalProb - 0.5;
    return kb - ka;
  });
}

module.exports = {
  americanToProb, probToAmerican, devig, poissonCdf, poissonSideProb,
  hitWindow, hitRates, blendedHitRate, scoreProp, rankProps,
};

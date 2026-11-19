// ════════════════════════════════════════════════════════════════════
//  Player props — settings. Tune here; nothing else needs editing.
//  Starting values (Nov 2026). Review after ~2 weeks of graded picks.
// ════════════════════════════════════════════════════════════════════

// How the final probability is built
const BLEND = {
  MODEL_WEIGHT: 0.60,        // final = 60% model + 40% blended hit rate
  HIT_WEIGHT: 0.40,
  WINDOW_WEIGHTS: { l5: 0.15, l10: 0.30, l25: 0.30, season: 0.25 },
  HIT_SHRINK_GAMES: 8,       // pulls small samples toward the market price (1/1 can't read as 100%)
};

// A prop must pass all of these to be a "Top pick"
const FILTERS = {
  MIN_GAMES: 8,              // games played this season
  MIN_FINAL_PROB: 0.55,
  MIN_EDGE: 0.03,            // +3% over the no-vig market price
  MIN_ODDS: -250,            // consensus price range
  MAX_ODDS: 150,
  MIN_BOOKS: 2,              // books currently offering the line (odds-feed mode only)
};

const TOP_N_DISCORD = 5;     // picks listed in the Discord post

// Player rate model (per-game Poisson)
const RATE = {
  PRIOR_GAMES: 10,           // season rate shrunk toward last season (or position default) by this many games
  RECENT_WEIGHT: 0.30,       // L10 rate share once a player has 5+ games
  TEAM_FACTOR_MIN: 0.80, TEAM_FACTOR_MAX: 1.25,   // tonight's team goal projection vs season average
  SHOTS_FACTOR_MIN: 0.88, SHOTS_FACTOR_MAX: 1.12, // opponent shots-against vs league average
  // Used when a player has no usable last season (rookies)
  POSITION_DEFAULTS: {
    F: { points: 0.50, assists: 0.30, goals: 0.20, shots: 2.0 },
    D: { points: 0.35, assists: 0.27, goals: 0.07, shots: 1.5 },
  },
};

// Markets per sport. `match` tests a SportsGameOdds statID; `stat` is the game-log field.
const MARKETS = {
  NHL: [
    { key: 'points',  label: 'Points',        stat: 'points',  match: s => s === 'points',  scoring: true },
    { key: 'assists', label: 'Assists',       stat: 'assists', match: s => s === 'assists', scoring: true },
    { key: 'goals',   label: 'Goals',         stat: 'goals',   match: s => s === 'goals',   scoring: true },
    { key: 'shots',   label: 'Shots on Goal', stat: 'shots',   match: s => /^shots_?on_?goal$/i.test(s), scoring: false },
  ],
  // Stage set for NFL — adapter in src/props/nfl.js is not built yet
  NFL: [
    { key: 'passing_yards',   label: 'Passing Yards',   match: s => s === 'passing_yards' },
    { key: 'rushing_yards',   label: 'Rushing Yards',   match: s => s === 'rushing_yards' },
    { key: 'receiving_yards', label: 'Receiving Yards', match: s => s === 'receiving_yards' },
    { key: 'receptions',      label: 'Receptions',      match: s => s === 'receiving_receptions' || s === 'receptions' },
  ],
};

// When there's no SportsGameOdds key, NHL still runs on standard lines (no edge, ranked by probability)
const FALLBACK = {
  SKATERS_PER_TEAM: 8,       // top skaters by ice time
  LINES: { points: [0.5], assists: [0.5], goals: [0.5], shots: [1.5, 2.5, 3.5] },
};

module.exports = { BLEND, FILTERS, TOP_N_DISCORD, RATE, MARKETS, FALLBACK };

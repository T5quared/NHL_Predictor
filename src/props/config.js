// ════════════════════════════════════════════════════════════════════
//  Player props — settings. Tune here; nothing else needs editing.
//  Starting values (Nov 2026). Review after ~2 weeks of graded picks.
// ════════════════════════════════════════════════════════════════════

// How the final probability is built (both sports)
const BLEND = {
  MODEL_WEIGHT: 0.60,        // final = 60% model + 40% blended hit rate
  HIT_WEIGHT: 0.40,
};

// Hit-rate windows per sport. Small samples are pulled toward the market price by SHRINK_GAMES.
const SPORTS = {
  NHL: {
    windows: [5, 10, 25],
    weights: { l5: 0.15, l10: 0.30, l25: 0.30, season: 0.25 },
    consistent: ['l10', 'l25', 'season'],   // all must beat the price for the ✓ badge
    shrinkGames: 8,
    minGames: 8,
    marketWeight: 0,          // share of Final % taken straight from the no-vig market price
  },
  NFL: {
    windows: [3, 5, 10],
    weights: { l3: 0.15, l5: 0.30, l10: 0.30, season: 0.25 },
    consistent: ['l5', 'l10', 'season'],
    shrinkGames: 4,
    minGames: 4,
    // New model, no track record yet and it disagrees with the books too often → anchor halfway to the market.
    // Lower toward 0 if the graded results show the model beating the market price.
    marketWeight: 0.5,
  },
};

// A prop must pass all of these to be a "Top pick"
const FILTERS = {
  MIN_FINAL_PROB: 0.55,
  MIN_EDGE: 0.03,            // +3% over the no-vig market price
  MIN_ODDS: -250,            // consensus price range
  MAX_ODDS: 150,
  MIN_BOOKS: 2,              // books currently offering the line (odds-feed mode only)
  // "Too good to be true" guards — when we disagree this much with the books, they usually know
  // something the stats don't (injury, depth-chart or role change). Shown in All props, never a Top pick.
  MAX_EDGE: 0.15,            // measured before the market anchor
  ROLE_RATIO_MIN: 0.60,      // our projection below 60% of the line, or
  ROLE_RATIO_MAX: 1.60,      // above 160% of it (lines over 1.5 only)
};

const TOP_N_DISCORD = 5;     // picks listed per sport in the Discord post
const MAX_TOP_PICKS = 20;    // per sport per run — the best N by edge that pass every filter

// NHL player rate model (per-game Poisson)
const RATE = {
  PRIOR_GAMES: 10,           // season rate shrunk toward last season (or position default) by this many games
  RECENT_WEIGHT: 0.30,       // L10 rate share once a player has 5+ games
  TEAM_FACTOR_MIN: 0.80, TEAM_FACTOR_MAX: 1.25,   // tonight's team goal projection vs season average
  SHOTS_FACTOR_MIN: 0.88, SHOTS_FACTOR_MAX: 1.12, // opponent shots-against vs league average
  POSITION_DEFAULTS: {       // used when a player has no usable last season (rookies)
    F: { points: 0.50, assists: 0.30, goals: 0.20, shots: 2.0 },
    D: { points: 0.35, assists: 0.27, goals: 0.07, shots: 1.5 },
  },
};

// NFL player model: yardage = normal distribution, receptions/TDs = Poisson
const NFL_RATE = {
  PRIOR_GAMES: 4,            // season average shrunk toward last season by this many games
  RECENT_WEIGHT: 0.25,       // L3 share once a player has 4+ games
  DEFENSE_MIN: 0.85, DEFENSE_MAX: 1.15,           // opponent allowed vs league average, same position group
  TD_DEFENSE_MIN: 0.80, TD_DEFENSE_MAX: 1.25,
  // Typical game-to-game spread as a share of the average (blended with the player's own spread)
  YARDS_CV: { passing_yards: 0.28, rushing_yards: 0.50, receiving_yards: 0.55 },
  POSITION_DEFAULTS: {       // per game, for rookies with little data
    QB: { passing_yards: 210, rushing_yards: 15, receiving_yards: 0, receptions: 0, td: 0.12 },
    RB: { passing_yards: 0, rushing_yards: 45, receiving_yards: 18, receptions: 2.2, td: 0.32 },
    WR: { passing_yards: 0, rushing_yards: 2, receiving_yards: 45, receptions: 3.6, td: 0.28 },
    TE: { passing_yards: 0, rushing_yards: 0, receiving_yards: 30, receptions: 3.0, td: 0.20 },
  },
  LOG_WITHIN_HOURS: 48,      // picks are logged for grading only for games this close (last run before kickoff wins)
  DISCORD_WITHIN_HOURS: 30,  // NFL picks listed in Discord only for games this close
};

// Markets per sport. `match` tests a SportsGameOdds statID; `stat` is the game-log field.
const MARKETS = {
  NHL: [
    { key: 'points',  label: 'Points',        short: 'PTS', stat: 'points',  match: s => s === 'points',  scoring: true },
    { key: 'assists', label: 'Assists',       short: 'AST', stat: 'assists', match: s => s === 'assists', scoring: true },
    { key: 'goals',   label: 'Goals',         short: 'G',   stat: 'goals',   match: s => s === 'goals',   scoring: true },
    { key: 'shots',   label: 'Shots on Goal', short: 'SOG', stat: 'shots',   match: s => /^shots_?on_?goal$/i.test(s), scoring: false },
  ],
  NFL: [
    { key: 'passing_yards',   label: 'Passing Yards',   short: 'PASS YDS', stat: 'passing_yards',   match: s => s === 'passing_yards',   dist: 'normal' },
    { key: 'rushing_yards',   label: 'Rushing Yards',   short: 'RUSH YDS', stat: 'rushing_yards',   match: s => s === 'rushing_yards',   dist: 'normal' },
    { key: 'receiving_yards', label: 'Receiving Yards', short: 'REC YDS',  stat: 'receiving_yards', match: s => s === 'receiving_yards', dist: 'normal' },
    { key: 'receptions',      label: 'Receptions',      short: 'REC',      stat: 'receptions',      match: s => s === 'receiving_receptions', dist: 'poisson' },
    { key: 'anytime_td',      label: 'Anytime TD',      short: 'ATD',      stat: 'td',              match: s => s === 'touchdowns', dist: 'poisson', yn: true },
  ],
};

// When there's no SportsGameOdds key, NHL still runs on standard lines (no edge, ranked by probability).
// NFL lines are player-specific, so NFL needs the key.
const FALLBACK = {
  SKATERS_PER_TEAM: 8,       // top skaters by ice time
  LINES: { points: [0.5], assists: [0.5], goals: [0.5], shots: [1.5, 2.5, 3.5] },
};

module.exports = { BLEND, SPORTS, FILTERS, TOP_N_DISCORD, MAX_TOP_PICKS, RATE, NFL_RATE, MARKETS, FALLBACK };

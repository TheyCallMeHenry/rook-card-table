// ---------------------------------------------------------------- ai.js
// Heuristic AI for partnership Rook. Pure decision-maker: reads game state,
// returns decision objects; NEVER mutates the engine. Every choice is drawn
// from legalMoves/legal state, so calls are legal-by-construction; the engine
// remains the final validator. rng (optional, e.g. makeRng(seed)) breaks
// exact evaluation ties only — default behavior is fully deterministic.
//
// Engine note (verified in engine.js _advanceAuction): when all four seats
// pass, the engine FORCES the dealer to a 70 contract itself. No bid call
// from the AI side is needed — and one would throw, since bidding is over.

import {
  cardCounters, cardId, parseCard, teamOf,
  SUITS, BIRD, MIN_BID, MAX_BID, BID_STEP,
} from './engine.js';

const toCard = (c) => (typeof c === 'string' ? parseCard(c) : c);
const plainCounter = (rank) => (rank === 5 ? 5 : rank === 10 || rank === 14 ? 10 : 0);
const maxRank = (cards) => cards.reduce((a, b) => (b.rank > a.rank ? b : a));

/**
 * Hand-strength score for bidding (exported for tests/UI hints).
 * Components: total counter points, length beyond 3 in the best plain suit,
 * honors (14/13/12) of that suit, bird bonus, void + singleton ruffing value.
 */
export function evaluateHand(hand) {
  const cards = hand.map(toCard);
  const bySuit = {};
  for (const s of SUITS) bySuit[s] = [];
  let bird = false;
  let counters = 0;
  for (const c of cards) {
    counters += cardCounters(c);
    if (c.suit === BIRD) bird = true;
    else bySuit[c.suit].push(c.rank);
  }
  // best plain suit by its own worth: counters + 2*length + honors
  let bestRanks = [];
  let bestScore = -1;
  for (const s of SUITS) {
    const r = bySuit[s];
    let sc = r.reduce((n, rank) => n + plainCounter(rank), 0) + 2 * r.length;
    if (sc > bestScore || (sc === bestScore && r.length > bestRanks.length)) {
      bestScore = sc;
      bestRanks = r;
    }
  }
  let honors = 0;
  if (bestRanks.includes(14)) honors += 4;
  if (bestRanks.includes(13)) honors += 2.5;
  if (bestRanks.includes(12)) honors += 1.5;
  let voids = 0, singles = 0;
  for (const s of SUITS) {
    if (bySuit[s].length === 0) voids++;
    else if (bySuit[s].length === 1) singles++;
  }
  const lengthBonus = Math.max(0, 2 * (bestRanks.length - 3));
  return counters + lengthBonus + honors + (bird ? 6 : 0) + 3 * voids + singles;
}

/** Bid ceiling justified by strength s. Null = pass, never enter the auction. */
function bidCeiling(s) {
  if (s < 26) return null;                       // junk: rely on the engine's forced-dealer-70
  const steps = Math.min(10, Math.floor((s - 26) / 4));
  return Math.min(MAX_BID, MIN_BID + steps * BID_STEP);
}

/**
 * Bidding decision for seat: {action:'bid', amount} | {action:'pass'}.
 * Never outbids a partner — partner's bid already describes their hand.
 */
export function decideBid(g, seat, opts = {}) {
  const moves = g.legalMoves(seat);
  if (moves.phase !== 'bidding' || !moves.turn) return { action: 'pass' };
  const ceiling = bidCeiling(evaluateHand(g.hands[seat]));
  const partnerHoldsHigh = g.highBid !== null && teamOf(g.highBid.seat) === teamOf(seat);
  const options = (moves.bids ?? []).filter((b) => ceiling !== null && b <= ceiling);
  if (!options.length || partnerHoldsHigh) return { action: 'pass' };
  // Opening: describe the hand at once (bid up to the strength ceiling).
  // Overcalling an opponent: one rung only — keep the auction cheap.
  const amount = g.highBid === null ? options[options.length - 1] : options[0];
  return { action: 'bid', amount }
}

/** Color worth: counters + 2*length + honors (14/13/12). Bird is trump-independent. */
function suitWorth(cards, suit) {
  const ranks = cards.filter((c) => c.suit === suit).map((c) => c.rank);
  let sc = ranks.reduce((n, rank) => n + plainCounter(rank), 0) + 2 * ranks.length;
  if (ranks.includes(14)) sc += 4;
  if (ranks.includes(13)) sc += 2.5;
  if (ranks.includes(12)) sc += 1.5;
  return sc;
}

/** Best trump color of the (post-nest) hand. */
function chooseTrump(hand, rng) {
  const cards = hand.map(toCard);
  const scored = SUITS.map((s) => ({ suit: s, w: suitWorth(cards, s) }));
  return pickMax(scored, (x) => x.w, (x) => x.suit, rng).suit;
}

/**
 * Keep-score per card for the nest discard; lowest 5 leave the hand.
 * Trap note (engine §9.10 / D-decision): nest-discard counters score for the
 * LAST-TRICK winner's team, not the bidder. So counters are the last to go
 * and the bird never goes; trumps stay to guard the bird. Among equals the
 * lowest ranks of non-trump suits ship — a suit we still honor with its 14
 * or 13 is one opponents cannot freely ride.
 */
function keepScore(card, bySuit, trump) {
  if (card.suit === BIRD) return Infinity;
  let k = cardCounters(card) * 1000;                 // counters: near-untouchable
  if (card.suit === trump) k += 500;                 // trump length pulls + guards bird
  k += (bySuit[card.suit]?.length ?? 0) * 5;         // length = ruffing/endgame value
  if (card.rank === 14) k += 30; else if (card.rank === 13) k += 20;
  return k + card.rank;                              // among equals: shed lowest first
}

function chooseDiscards(hand, trump) {
  const cards = hand.map(toCard);
  const bySuit = {};
  for (const c of cards) if (c.suit !== BIRD) (bySuit[c.suit] ??= []).push(c);
  const ranked = cards
    .map((c, i) => ({ c, i, k: keepScore(c, bySuit, trump) }))
    .sort((a, b) => a.k - b.k || a.i - b.i);         // stable: deal order breaks ties
  return ranked.slice(0, 5).map((x) => cardId(x.c));
}

/**
 * Contract-setup decision for the declarer, one engine step at a time:
 * {action:'takeNest'} -> {action:'discard', trump, cards:[5 ids]} -> {action:'callTrump', suit}.
 * Trump is picked from the full 18; discards never target trumps or counters,
 * so the recomputed trump after discarding (below) is the same suit.
 */
export function decideContract(g, seat, opts = {}) {
  if (g.phase !== 'contract_setup' || g.contract?.seat !== seat) return { action: 'pass' };
  if (!g.nestTaken) return { action: 'takeNest' };
  const trump = chooseTrump(g.hands[seat], opts.rng);
  if (!g.nestDiscard) return { action: 'discard', trump, cards: chooseDiscards(g.hands[seat], trump) };
  return { action: 'callTrump', suit: trump };
}

// ------------------------------------------------------------ trick logic

/** Winning card of a trick: bird beats all, else highest trump, else highest led-suit. */
function trickWinner(cards, trump) {
  const bird = cards.find((c) => c.suit === BIRD);
  if (bird) return bird;
  const trumps = cards.filter((c) => c.suit === trump);
  if (trumps.length) return maxRank(trumps);
  const led = cards[0].suit;
  return maxRank(cards.filter((c) => c.suit === led));
}

/**
 * Play decision: chooses ONLY from g.legalMoves(seat).cards and returns
 * {action:'play', card:id} (null when not this seat's turn to play).
 * Never forces renee: a doomed renee forfeits 120+, so the AI plays for points.
 */
export function decidePlay(g, seat, opts = {}) {
  const moves = g.legalMoves(seat);
  if (moves.phase !== 'playing' || !moves.turn) return null;
  const legal = (moves.cards ?? []).map(parseCard);
  const snap = g.snapshot();
  const trump = snap.trumpSuit;

  if (snap.trick.length === 0) {
    const mine = g.hands[seat].map(toCard);
    return { action: 'play', card: cardId(pickLead(mine, legal, trump, opts.rng)) };
  }

  // Following: who is winning so far, and how many points ride the trick?
  const trickCards = snap.trick.map((t) => parseCard(t.card));
  const trickPts = trickCards.reduce((n, c) => n + cardCounters(c), 0);
  const winCard = trickWinner(trickCards, trump);
  const winnerSeat = snap.trick[trickCards.indexOf(winCard)].seat;

  if (teamOf(winnerSeat) === teamOf(seat)) {
    // Ally wins: shed junk (off-trump non-counters lowest first). Counters
    // only go when we are void of everything else — then shed the cheapest,
    // keeping the high ones to cash later.
    const junk = legal.filter((c) => cardCounters(c) === 0 && c.suit !== trump);
    const pool = junk.length ? junk : legal.filter((c) => cardCounters(c) === 0);
    return { action: 'play', card: cardId(pickCheap(pool.length ? pool : legal, trump, opts.rng)) };
  }

  // Opponent wins so far: win the trick with the cheapest non-bird card.
  const winners = legal.filter((c) => trickWinner([...trickCards, c], trump) === c);
  const cheap = winners.filter((c) => c.suit !== BIRD);
  if (cheap.length) return { action: 'play', card: cardId(pickCheap(cheap, trump, opts.rng)) };
  // Bird commit: it is the ONLY winner and the trick actually carries points.
  if (winners.length && winners.every((c) => c.suit === BIRD) && trickPts >= 5) {
    return { action: 'play', card: BIRD };
  }
  const dump = legal.filter((c) => cardCounters(c) === 0 && c.suit !== trump);
  return { action: 'play', card: cardId(pickCheap(dump.length ? dump : legal, trump, opts.rng)) };
}

/** Cheapest card = lowest rank; trumps cost +15 so off-suit is preferred for dumps. */
function pickCheap(cards, trump, rng) {
  const scored = cards.map((c) => ({ c, k: c.suit === trump ? 15 + c.rank : c.rank }));
  return pickMax(scored, (x) => -x.k, (x) => cardId(x.c), rng).c;
}

/** Leading: pull trumps when long, cash an ace-backed counter, else exit cheapest. */
function pickLead(mine, legal, trump, rng) {
  const myTrumps = mine.filter((c) => c.suit === trump);
  const legalTrumps = legal.filter((c) => c.suit === trump);
  if (myTrumps.length >= 3 && legalTrumps.length) return pickCheap(legalTrumps, trump, rng);

  // counters: cash a 10/5 in a plain suit we also hold the 14 of — likely rides
  const bySuit = {};
  for (const c of mine) if (c.suit !== BIRD) (bySuit[c.suit] ??= []).push(c);
  const legalIds = new Set(legal.map(cardId));
  for (const s of SUITS) {
    const r = (bySuit[s] ?? []).filter((c) => c.suit !== trump && legalIds.has(cardId(c)));
    if (!r.some((c) => c.rank === 14)) continue;
    const counter = r.filter((c) => c.rank === 10 || c.rank === 5).sort((a, b) => a.rank - b.rank)[0];
    if (counter) return counter;
  }

  if (myTrumps.length >= 2 && legalTrumps.length) return pickCheap(legalTrumps, trump, rng);
  // no cash available: exit cheapest from the longest plain suit
  const plains = legal.filter((c) => c.suit !== BIRD && c.suit !== trump);
  const suitsByLen = SUITS.map((s) => ({ s, n: bySuit[s]?.length ?? 0 }))
    .sort((a, b) => b.n - a.n || SUITS.indexOf(a.s) - SUITS.indexOf(b.s));
  const longest = suitsByLen.find((x) => plains.some((c) => c.suit === x.s));
  const fromLong = longest ? plains.filter((c) => c.suit === longest.s) : plains;
  return pickCheap(fromLong.length ? fromLong : legal, trump, rng);
}

/** Max by key; exact ties go to rng when given, else to the lowest tieKey. */
function pickMax(items, key, tieKey, rng) {
  const best = Math.max(...items.map(key));
  const tied = items.filter((x) => key(x) === best);
  if (tied.length === 1) return tied[0];
  if (rng) return tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))];
  tied.sort((a, b) => (tieKey(a) < tieKey(b) ? -1 : 1));
  return tied[0];
}

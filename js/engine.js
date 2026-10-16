/**
 * engine.js — pure deterministic rules engine for partnership Rook.
 * Codes exactly against docs/rook-rules-research-2026-10-15.md §9 items 1-15,
 * with §8 fork recommendations as defaults. Zero DOM/window/document refs;
 * importable from Node ESM and browser ESM. All randomness via injected RNG.
 */

// ---------------------------------------------------------------- debug (§ UI-gated logging)

export let DEBUG = false;
/** Toggle '[rook]' console.debug logging (default off). */
export function setDebug(on) { DEBUG = Boolean(on); }
function dbg(...args) { if (DEBUG) console.debug('[rook]', ...args); }

// ---------------------------------------------------------------- constants

export const SUITS = ['R', 'Y', 'G', 'B'];
export const BIRD = 'BIRD';            // bird is its own suit and is the highest trump, always (§9.2)
export const HAND_SIZE = 13;
export const NEST_SIZE = 5;
export const TRICKS_PER_HAND = 13;
export const MIN_BID = 70;
export const MAX_BID = 120;
export const BID_STEP = 5;
export const DEFAULT_TARGET = 300;     // app may pass 150 (documented house shortening, F10)

export class RookError extends Error {
  constructor(msg) { super(msg); this.name = 'RookError'; }
}

/** Seats 0 & 2 are partners; seats 1 & 3 are partners (§8 partnership default). */
export function teamOf(seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new RookError(`bad seat ${seat}`);
  return seat % 2;
}

// ---------------------------------------------------------------- cards

/** Full 57-card deck: R/Y/G/B x ranks 1..14 + the bird (§9.1). */
export function fullDeck() {
  const deck = [];
  for (const suit of SUITS) for (let rank = 1; rank <= 14; rank++) deck.push({ suit, rank });
  deck.push({ suit: BIRD, rank: null });
  return deck;
}

/** Parse 'R12' / 'bird' (case-insensitive) into a card object. */
export function parseCard(str) {
  if (typeof str !== 'string') throw new RookError(`cannot parse card from ${str}`);
  const s = str.trim().toUpperCase();
  if (s === BIRD) return { suit: BIRD, rank: null };
  const m = /^([RYGB])(\d{1,2})$/.exec(s);
  if (!m) throw new RookError(`unparseable card "${str}"`);
  const rank = Number(m[2]);
  if (!Number.isInteger(rank) || rank < 1 || rank > 14) throw new RookError(`rank out of range in "${str}"`);
  return { suit: m[1], rank };
}

/** Canonical string id, e.g. 'R12', 'BIRD'. */
export function cardId(c) { return c.suit === BIRD ? BIRD : `${c.suit}${c.rank}`; }

/** Counter value: 5=5, 10=10, 14=10, bird=20, else 0. Deck total = 120 (§9.9). */
export function cardCounters(card) {
  if (card.suit === BIRD) return 20;
  if (card.rank === 5) return 5;
  if (card.rank === 10 || card.rank === 14) return 10;
  return 0;
}

// ---------------------------------------------------------------- rng

/** Seeded mulberry32 PRNG returning [0,1). Injected into createGame for determinism. */
export function makeRng(seed) {
  let a = (seed >>> 0);
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(deck, rng) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = d[i]; d[i] = d[j]; d[j] = tmp;
  }
  return d;
}

// ---------------------------------------------------------------- settlement (pure, §9.10-11, §9.12)

/**
 * Pure bid settlement. Inputs:
 *  bid             contract amount (number)
 *  contractTeam    0|1
 *  trickCounters   [4] counters each seat captured in completed tricks
 *  nestCounters    counters sitting in the face-down nest discard (§9.10)
 *  lastTrickTaker  seat that took the last trick — their team gets the nest; null => no award
 *  rene            renee void: bid team subtracts the bid, opponents add counters already captured
 * Returns { outcome, deltas:[dTeam0,dTeam1], teamTotals, trickTeamTotals, nestAwardTeam, ... }.
 */
export function resolveSettlement({ bid, contractTeam, trickCounters, nestCounters = 0, lastTrickTaker = null, rene = false }) {
  if (!Number.isFinite(bid)) throw new RookError('settlement: bid must be finite');
  if (contractTeam !== 0 && contractTeam !== 1) throw new RookError('settlement: contractTeam must be 0 or 1');
  if (!Array.isArray(trickCounters) || trickCounters.length !== 4 || !trickCounters.every(Number.isFinite)) {
    throw new RookError('settlement: trickCounters must be 4 finite numbers');
  }
  if (!Number.isFinite(nestCounters)) throw new RookError('settlement: nestCounters must be finite');
  if (lastTrickTaker !== null && !Number.isInteger(lastTrickTaker)) throw new RookError('settlement: bad lastTrickTaker');

  const trickTeamTotals = [trickCounters[0] + trickCounters[2], trickCounters[1] + trickCounters[3]];
  const nestAwardTeam = (!rene && lastTrickTaker !== null) ? teamOf(lastTrickTaker) : null;
  const teamTotals = [
    trickTeamTotals[0] + (nestAwardTeam === 0 ? nestCounters : 0),
    trickTeamTotals[1] + (nestAwardTeam === 1 ? nestCounters : 0),
  ];
  const oppTeam = contractTeam ^ 1;
  const deltas = [0, 0];
  let outcome;
  if (rene) {
    // Official: hand stops at that trick; bid team subtracts its bid whichever team erred (§9.12).
    outcome = 'rene-void';
    deltas[contractTeam] = -bid;
    deltas[oppTeam] = teamTotals[oppTeam];
  } else if (teamTotals[contractTeam] >= bid) {
    outcome = 'made';                                   // §9.11: bid team adds its full counter total
    deltas[contractTeam] = teamTotals[contractTeam];
    deltas[oppTeam] = teamTotals[oppTeam];
  } else {
    outcome = 'failed';                                 // §9.11: fail subtracts the FULL bid
    deltas[contractTeam] = -bid;
    deltas[oppTeam] = teamTotals[oppTeam];
  }
  if (!deltas.every(Number.isFinite)) throw new RookError('settlement produced a non-finite score');
  return { outcome, deltas, teamTotals, trickTeamTotals, nestAwardTeam, contractTeam, bid };
}

// ---------------------------------------------------------------- game

/**
 * Factory (preferred entry point). Auto-deals hand 1; phase then 'pre_bid'.
 * config: { target=300, seed?, rng?, dealer=0, SHOOT_MOON=false, ONE_HIGH=false }.
 * SHOOT_MOON / ONE_HIGH default OFF and are NOT implemented: passing true throws (§9.14).
 */
export function createGame(config = {}) { return new RookGame(config); }

export class RookGame {
  constructor(config = {}) {
    if (config.SHOOT_MOON) throw new RookError('SHOOT_MOON is not implemented (flag exists, default off, §9.14)');
    if (config.ONE_HIGH) throw new RookError('ONE_HIGH is not implemented (flag exists, default off, §9.14)');

    this.target = config.target ?? DEFAULT_TARGET;
    if (!Number.isFinite(this.target) || this.target <= 0) throw new RookError('target must be a positive number');

    if (config.rng !== undefined) {
      if (typeof config.rng !== 'function') throw new RookError('rng must be a function');
      this.rng = config.rng;
      this.seed = null;
    } else {
      this.seed = config.seed ?? Math.floor(Math.random() * 4294967296);
      this.rng = makeRng(this.seed);
    }

    this.dealer = config.dealer ?? 0;
    if (!Number.isInteger(this.dealer) || this.dealer < 0 || this.dealer > 3) throw new RookError('bad dealer seat');

    this.scores = [0, 0];        // per TEAM
    this.handNumber = 1;
    this.winner = null;          // 0|1 once game_over (§9.13)
    this._resetHand();
    this._deal();                // createGame deals hand 1
    dbg('created', { target: this.target, seed: this.seed, dealer: this.dealer });
  }

  // -------------------------------------------------------------- dealing

  /** Fresh shuffled deck, same dealer: used by createGame and redeal (§9.4). Rotates only via nextHand(). */
  deal() {
    this._resetHand();
    this._deal();
    this.phase = 'pre_bid';
  }

  _deal() {
    const deck = shuffled(fullDeck(), this.rng);
    this.hands = [[], [], [], []];
    this.nest = [];
    const first = (this.dealer + 1) % 4;
    const order = [0, 1, 2, 3].map((i) => (first + i) % 4);   // start left of dealer, clockwise (§9.3)
    let p = 0;
    for (let round = 1; round <= TRICKS_PER_HAND; round++) {
      for (const s of order) this.hands[s].push(deck[p++]);
      if (round <= 4) this.nest.push(deck[p++]);               // one face-down to the nest after each of the first 4 full rounds (§9.3)
    }
    while (p < deck.length) this.nest.push(deck[p++]);         // leftover card(s) finish the nest at exactly 5 (§9.3)
    dbg('dealt', { handNumber: this.handNumber, nest: this.nest.length });
  }

  _resetHand() {
    this.phase = 'pre_bid';        // pre_bid -> bidding -> contract_setup -> playing -> hand_over | game_over
    this.currentBidder = (this.dealer + 1) % 4;
    this.passed = [false, false, false, false];
    this.highBid = null;           // { seat, amount }
    this.contract = null;          // { seat, bid, allPassForced }
    this.redealTaken = false;
    this.nestTaken = false;
    this.nestDiscard = null;       // the declarer's 5 face-down discards (affects scoring, §9.10)
    this.trumpSuit = null;
    this.currentPlayer = null;
    this.leader = null;
    this.trick = [];               // current trick: [{ seat, card }]
    this.tricks = [];              // completed: { cards, winner } — hidden from snapshot until hand end (§8)
    this.tricksWon = [0, 0, 0, 0];
    this.lastTrickTaker = null;
    this.lastHandResult = null;
    this.reneeSeat = null;
  }

  /** Total counters in this hand: 120 on every deal (§9.9 invariant). */
  dealCountersTotal() {
    let n = 0;
    for (const h of this.hands) for (const c of h) n += cardCounters(c);
    for (const c of this.nest) n += cardCounters(c);
    return n;
  }

  // -------------------------------------------------------------- redeal (§9.4)

  /** Open the auction once the pre-bid redeal window passes unused (pre_bid -> bidding). */
  startBidding() {
    if (this.phase !== 'pre_bid') throw new RookError('can only start bidding from the pre-bid window');
    this.phase = 'bidding';
    dbg('bidding opened', { currentBidder: this.currentBidder });
  }

  canDemandRedeal(seat) {
    return this.phase === 'pre_bid' && !this.redealTaken &&
      this.hands[seat].reduce((n, c) => n + cardCounters(c), 0) === 0;
  }

  /** A hand with zero counters may demand ONE redeal before any bid (same dealer reshuffles). */
  demandRedeal(seat) {
    if (this.phase !== 'pre_bid') throw new RookError('redeal only allowed before the first bid');
    if (this.redealTaken) throw new RookError('one redeal per hand maximum');
    const cnt = this.hands[seat].reduce((n, c) => n + cardCounters(c), 0);
    if (cnt !== 0) throw new RookError(`seat ${seat} holds ${cnt} counters — no redeal`);
    this.redealTaken = true;
    this._deal();
    this.phase = 'bidding';        // redeal done: auction opens
    dbg('redeal demanded', { seat });
  }

  // -------------------------------------------------------------- bidding (§9.5)

  bid(seat, amount) {
    if (this.phase !== 'bidding') throw new RookError('bid only during bidding phase');
    if (seat !== this.currentBidder) throw new RookError(`not seat ${seat}'s turn to bid (seat ${this.currentBidder})`);
    if (!Number.isInteger(amount)) throw new RookError('bid must be an integer');
    if (amount < MIN_BID || amount > MAX_BID) throw new RookError(`bid must be within ${MIN_BID}..${MAX_BID}`);
    if (amount % BID_STEP !== 0) throw new RookError('bid must be a multiple of 5');
    if (this.highBid && amount <= this.highBid.amount) throw new RookError(`bid must exceed ${this.highBid.amount}`);
    this.highBid = { seat, amount };
    dbg('bid', { seat, amount });
    this._advanceAuction();
  }

  pass(seat) {
    if (this.phase !== 'bidding') throw new RookError('pass only during bidding phase');
    if (seat !== this.currentBidder) throw new RookError(`not seat ${seat}'s turn to pass (seat ${this.currentBidder})`);
    this.passed[seat] = true;      // passing leaves the auction permanently (§9.5)
    dbg('pass', { seat });
    this._advanceAuction();
  }

  _advanceAuction() {
    const remaining = [0, 1, 2, 3].filter((s) => !this.passed[s]);
    if (remaining.length <= 1) {   // three passed => remaining player is high bidder; all passed => dealer forced to 70 (§9.5, F11)
      const allPassOrLastStanding = this.highBid === null;
      if (!this.highBid) {
        const forcedSeat = remaining.length === 1 ? remaining[0] : this.dealer;
        this.highBid = { seat: forcedSeat, amount: MIN_BID };
      }
      this.contract = { seat: this.highBid.seat, bid: this.highBid.amount, allPassForced: allPassOrLastStanding };
      this.currentBidder = null;
      this.phase = 'contract_setup';
      dbg('auction over', this.contract);
      return;
    }
    do { this.currentBidder = (this.currentBidder + 1) % 4; } while (this.passed[this.currentBidder]);
  }

  legalBids() {
    if (this.phase !== 'bidding') return [];
    const min = this.highBid ? this.highBid.amount + BID_STEP : MIN_BID;
    const out = [];
    for (let b = Math.max(min, MIN_BID); b <= MAX_BID; b += BID_STEP) out.push(b);
    return out;
  }

  // -------------------------------------------------------------- contract setup (§9.6)

  /** Declarer pulls the 5 nest cards into hand (13 -> 18) and sees them. Returns a copy. */
  takeNest(seat) {
    if (this.phase !== 'contract_setup') throw new RookError('takeNest only during contract_setup');
    if (seat !== this.contract.seat) throw new RookError('only the high bidder takes the nest');
    if (this.nestTaken) throw new RookError('nest already taken');
    this.nestTaken = true;
    this.hands[seat] = this.hands[seat].concat(this.nest);
    dbg('nest taken', { seat, handSize: this.hands[seat].length });
    return this.nest.slice();
  }

  /** Declarer discards EXACTLY 5 cards face-down (any cards allowed). */
  discard(seat, cards) {
    if (this.phase !== 'contract_setup') throw new RookError('discard only during contract_setup');
    if (seat !== this.contract.seat) throw new RookError('only the high bidder discards');
    if (!this.nestTaken) throw new RookError('take the nest before discarding');
    if (this.nestDiscard) throw new RookError('already discarded');
    if (!Array.isArray(cards) || cards.length !== NEST_SIZE) throw new RookError(`must discard exactly ${NEST_SIZE} cards`);
    const removed = [];
    for (const spec of cards) {
      const card = this._resolveCard(seat, spec);
      const id = cardId(card);
      const idx = this.hands[seat].findIndex((c) => cardId(c) === id);
      if (idx < 0) throw new RookError(`${id} not in seat ${seat}'s hand (already discarded?)`);
      this.hands[seat].splice(idx, 1);
      removed.push(card);
    }
    this.nestDiscard = removed;
    dbg('discarded', { seat, ids: removed.map(cardId) });
  }

  /** Declarer names one of the 4 colors as trump; play begins, left of dealer leads trick 1 (§9.6-7). */
  callTrump(seat, suit) {
    if (this.phase !== 'contract_setup') throw new RookError('callTrump only during contract_setup');
    if (seat !== this.contract.seat) throw new RookError('only the high bidder calls trump');
    if (!this.nestDiscard) throw new RookError('discard before calling trump');
    if (!SUITS.includes(suit)) throw new RookError('trump must be one of R,Y,G,B');
    this.trumpSuit = suit;
    this.phase = 'playing';
    this.leader = (this.dealer + 1) % 4;
    this.currentPlayer = this.leader;
    dbg('trump called', { suit, leader: this.leader });
  }

  // -------------------------------------------------------------- play (§9.7-8, §7 bird rules)

  /**
   * All legal cards for the current player (throws if not their turn / wrong phase):
   *  - lead: any card.
   *  - led bird: must play a trump (trump-suit card) if able (§7 bird-forcing).
   *  - led trump color: must play trump — incl. the bird; if the bird is your only trump it is FORCED (§7).
   *  - led non-trump color: must follow color; only the bird may break following (§7).
   *  - void in led color: any card (incl. trump, incl. bird) (§7).
   */
  legalPlays(seat) {
    if (this.phase !== 'playing') throw new RookError('legalPlays only during play');
    if (seat !== this.currentPlayer) throw new RookError(`not seat ${seat}'s turn (seat ${this.currentPlayer})`);
    const hand = this.hands[seat];
    if (this.trick.length === 0) return hand.slice();
    const led = this.trick[0].card;
    if (led.suit === BIRD) {                       // bird is always trump; everyone plays a trump if able
      const trumps = hand.filter((c) => c.suit === this.trumpSuit);
      return trumps.length ? trumps : hand.slice();
    }
    if (led.suit === this.trumpSuit) {
      const trumps = hand.filter((c) => c.suit === this.trumpSuit || c.suit === BIRD);
      return trumps.length ? trumps : hand.slice();
    }
    const follow = hand.filter((c) => c.suit === led.suit);
    if (follow.length) {
      const bird = hand.filter((c) => c.suit === BIRD);
      return follow.concat(bird);                  // bird may break following while able
    }
    return hand.slice();                           // void: anything goes
  }

  isLegalPlay(seat, cardSpec) {
    try {
      const card = this._resolveCard(seat, cardSpec);
      return this.legalPlays(seat).some((c) => cardId(c) === cardId(card));
    } catch (e) {
      if (e instanceof RookError) return false;
      throw e;
    }
  }

  /** Play a card (object or id string). Illegal plays throw RookError — that reject IS the renee fixable-window (§9.12). */
  playCard(seat, cardSpec) {
    if (this.phase !== 'playing') throw new RookError('play only during playing phase');
    if (seat !== this.currentPlayer) throw new RookError(`not seat ${seat}'s turn (seat ${this.currentPlayer})`);
    const card = this._resolveCard(seat, cardSpec);
    const id = cardId(card);
    if (!this.legalPlays(seat).some((c) => cardId(c) === id)) {
      throw new RookError(`illegal play ${id} by seat ${seat} (led ${cardId(this.trick[0]?.card ?? { suit: BIRD, rank: null })})`);
    }
    this.hands[seat] = this.hands[seat].filter((c) => cardId(c) !== id);
    this.trick.push({ seat, card });
    dbg('played', { seat, id });
    if (this.trick.length === 4) {                 // each trick consumes exactly 4 cards (§9.15 invariant)
      const winner = this._trickWinner(this.trick);
      this.tricks.push({ cards: this.trick, winner });
      this.tricksWon[winner] += 1;
      this.lastTrickTaker = winner;
      this.trick = [];
      this.leader = winner;
      dbg('trick won', { winner, n: this.tricks.length });
    }
    if (this.tricks.length === TRICKS_PER_HAND) {
      this._settle({ rene: false });
    } else {
      this.currentPlayer = this.trick.length === 0 ? this.leader : (seat + 1) % 4;
    }
  }

  _trickWinner(entries) {
    const ledSuit = entries[0].card.suit;
    const trumps = entries.filter((e) => e.card.suit === BIRD || e.card.suit === this.trumpSuit);
    let pool;
    if (trumps.length) {
      const bird = trumps.find((e) => e.card.suit === BIRD);
      if (bird) return bird.seat;                  // bird is the highest trump (§9.2)
      pool = trumps;
    } else {
      pool = entries.filter((e) => e.card.suit === ledSuit);   // off-suit non-trump cannot win (§9.8)
    }
    return pool.reduce((best, e) => (e.card.rank > best.card.rank ? e : best)).seat;
  }

  // -------------------------------------------------------------- renee (§9.12)

  /**
   * Declare a renee (discovered illegal play). Fixable until the next lead = the engine simply
   * rejects illegal plays while the window is open; declaring after that stops the hand at this
   * trick: bid team subtracts the bid (whichever side erred), opponents add counters already
   * captured. Unfinished-trick cards and the nest score for nobody.
   */
  declareRenee(seat = this.currentPlayer) {
    if (this.phase !== 'playing') throw new RookError('renees can only be declared during play');
    this.reneeSeat = seat;
    dbg('rene declared', { seat });
    this._settle({ rene: true });
  }

  // -------------------------------------------------------------- settlement + hand end

  countersBySeat() {
    const out = [0, 0, 0, 0];
    for (const t of this.tricks) for (const p of t.cards) out[t.winner] += cardCounters(p.card);
    return out;
  }

  nestCounters() {
    if (!this.nestDiscard) return 0;
    return this.nestDiscard.reduce((n, c) => n + cardCounters(c), 0);
  }

  _settle({ rene }) {
    const trickCounters = this.countersBySeat();
    const nestCounters = this.nestCounters();
    const res = resolveSettlement({
      bid: this.contract.bid,
      contractTeam: teamOf(this.contract.seat),
      trickCounters,
      nestCounters,
      lastTrickTaker: rene ? null : this.lastTrickTaker,
      rene,
    });
    this.scores[0] += res.deltas[0];
    this.scores[1] += res.deltas[1];
    this.lastHandResult = {
      ...res,
      trickCounters,
      nestCounters,
      rene,
      reneeSeat: rene ? this.reneeSeat : null,
      contractSeat: this.contract.seat,
      lastTrickTaker: this.lastTrickTaker,
    };
    this.winner = this._checkGameEnd();
    this.phase = this.winner === null ? 'hand_over' : 'game_over';
    dbg('settled', this.lastHandResult.outcome, { scores: this.scores, winner: this.winner });
  }

  /** §9.13: checked only after a complete hand. Tie above target => null => another hand. */
  _checkGameEnd() {
    const [a, b] = this.scores;
    if (a >= this.target && b < this.target) return 0;
    if (b >= this.target && a < this.target) return 1;
    if (a >= this.target && b >= this.target) {
      if (a > b) return 0;
      if (b > a) return 1;
    }
    return null;
  }

  /** After hand_over (not game_over): rotate dealer clockwise and deal the next hand (§9.1). */
  nextHand() {
    if (this.phase !== 'hand_over') throw new RookError('nextHand only after a completed hand');
    this.dealer = (this.dealer + 1) % 4;
    this.handNumber += 1;
    this._resetHand();
    this._deal();
    dbg('next hand', { dealer: this.dealer, handNumber: this.handNumber });
  }

  // -------------------------------------------------------------- queries / snapshot

  _resolveCard(seat, spec) {
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new RookError(`bad seat ${seat}`);
    const card = typeof spec === 'string' ? parseCard(spec) : spec;
    if (!card || !card.suit) throw new RookError('card must be an object or id string');
    const id = cardId(card);
    if (!this.hands[seat].some((c) => cardId(c) === id)) throw new RookError(`${id} not in seat ${seat}'s hand`);
    return card;
  }

  /** What may this seat do right now? UI-facing helper. */
  legalMoves(seat) {
    const out = { phase: this.phase, seat };
    switch (this.phase) {
      case 'pre_bid':
        return Object.assign(out, { redeal: this.canDemandRedeal(seat) });
      case 'bidding': {
        const turn = seat === this.currentBidder && !this.passed[seat];
        return Object.assign(out, { turn, bids: turn ? this.legalBids() : [], canPass: turn });
      }
      case 'contract_setup': {
        const turn = seat === this.contract.seat;
        return Object.assign(out, {
          turn,
          needsTakeNest: turn && !this.nestTaken,
          needsDiscard: turn && this.nestTaken && !this.nestDiscard,
          needsTrump: turn && Boolean(this.nestDiscard),
        });
      }
      case 'playing': {
        const turn = seat === this.currentPlayer;
        return Object.assign(out, { turn, cards: turn ? this.legalPlays(seat).map(cardId) : [] });
      }
      case 'hand_over':
        return Object.assign(out, { nextHand: true });
      case 'game_over':
        return Object.assign(out, { winner: this.winner });
      default:
        return out;
    }
  }

  /** Serializable state snapshot. Hidden info respected: nest contents and completed tricks are
   *  withheld until the hand is over (§8); hands are never included — query game.hands/seat. */
  snapshot() {
    const revealed = this.phase === 'hand_over' || this.phase === 'game_over';
    return {
      phase: this.phase,
      target: this.target,
      scores: this.scores.slice(),
      winner: this.winner,
      dealer: this.dealer,
      handNumber: this.handNumber,
      currentBidder: this.currentBidder,
      highBid: this.highBid ? { ...this.highBid } : null,
      passed: this.passed.slice(),
      contract: this.contract ? { ...this.contract } : null,
      trumpSuit: this.trumpSuit,
      currentPlayer: this.currentPlayer,
      leader: this.leader,
      trick: this.trick.map(({ seat, card }) => ({ seat, card: cardId(card) })),
      tricksWon: this.tricksWon.slice(),
      countersBySeat: this.countersBySeat(),
      nestTaken: this.nestTaken,
      nest: revealed ? this.nest.map(cardId) : null,
      nestDiscard: revealed && this.nestDiscard ? this.nestDiscard.map(cardId) : null,
      tricks: revealed ? this.tricks.map((t) => ({ winner: t.winner, cards: t.cards.map((p) => ({ seat: p.seat, card: cardId(p.card) })) })) : null,
      lastHandResult: this.lastHandResult,
    };
  }

  /** Who's winning right now (score level): {scores, leadingTeam|null, target}. */
  whoIsWinning() {
    const [a, b] = this.scores;
    return { scores: this.scores.slice(), leadingTeam: a === b ? null : a > b ? 0 : 1, target: this.target };
  }
}

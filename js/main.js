/**
 * main.js — game flow orchestrator: state machine, AI pacing, wiring.
 * Engine is never modified: every engine call goes through tryEngine(),
 * which turns a RookError into an announcement instead of an exception.
 */
import { createGame, cardId, parseCard, cardCounters, setDebug, SUITS, BIRD } from './engine.js';
import { decideBid, decideContract, decidePlay } from './ai.js';
import * as UI from './ui.js';
import * as Sfx from './audio.js';

const HUMAN = 0;
// Hidden drive params — absent (default) leaves every path byte-for-byte as before.
const PARAMS = new URLSearchParams(window.location.search);
const AUTOPLAY = PARAMS.has('autoplay');   // seat 0 takes the exact AI-seat code paths
const FAST = PARAMS.has('fast');           // ~80 ms AI pacing, ~10 ms deal stagger
const rawSeed = PARAMS.has('seed') ? Number(PARAMS.get('seed')) : null;
const SEED = rawSeed !== null && Number.isFinite(rawSeed) ? rawSeed : null;
// Speed of play: HUD "Speed" menu, persisted in localStorage; QA override ?speed=slow|normal|instant.
const SPEED_KEY = 'rook.speed';
const SPEED_MODES = ['slow', 'normal', 'instant'];
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: session-only speed */ } };
let speedMode = SPEED_MODES.includes((PARAMS.get('speed') || '').toLowerCase())
  ? (PARAMS.get('speed') || '').toLowerCase()
  : (SPEED_MODES.includes(lsGet(SPEED_KEY)) ? lsGet(SPEED_KEY) : 'normal');
// JS-side pacing, recomputed by applySpeed(); FAST keeps the exact test-harness timings.
const T = { ai: 700, linger: 1700, stagger: 40, tail: 320, fly: 480 };
function applySpeed() {
  const mult = speedMode === 'slow' ? 3 : 1;
  const instant = speedMode === 'instant';
  document.documentElement.classList.toggle('instant', instant);
  T.ai = FAST ? 80 : 700 * mult;         // pause between any two AI decisions
  T.linger = FAST ? 700 : 1700 * mult;   // all four played cards stay face-up on the table this long
  T.stagger = FAST ? 10 : (instant ? 0 : 40 * mult); // deal stagger in ms/card
  T.tail = instant ? 0 : 320;          // deal animation tail (same under FAST, as before)
  T.fly = instant ? 0 : 480;             // trick-card fly-out animation
}

let g = null;
let pumpTimer = null;
let busy = false;                  // an animation is running; no ticks/clicks
let trickIds = [];
let trickNodes = [];
let selectedDiscards = new Set();
let nestIds = new Set();
let settleShownFor = -1;
let gameOverShown = false;
let lastPhase = null;
let aiFailStreak = 0;               // consecutive AI/fallback failures; >=8 stops the pump (Review B #1/#2)
let deferrals = [];                 // pending cosmetic timers (deal SFX, delayed renders) cleared on re-entry (Review B #4/#5)

/* ------------------------------------------------------------ engine gate */

function tryEngine(fn, label) {
  try {
    fn();
    return true;
  } catch (e) {
    if (e && e.name === 'RookError') {
      console.debug('[rook]', label, e.message);
      UI.announce(`Illegal move: ${e.message}`);
    } else {
      console.debug('[rook]', label, e);
      UI.announce('Unexpected engine problem — check the console.');
    }
    return false;
  }
}

const handIds = (seat) => {
  const ids = g.hands[seat].map(cardId);
  // Display order (seat 0 only; engine order untouched — all actions use card ids):
  // group by suit, highest first; bird last; when trump is fixed, trump group sits rightmost.
  if (seat !== HUMAN) return ids;
  const trump = g.trumpSuit;
  const SUIT_ORDER = trump ? [...SUITS.filter((s) => s !== trump), trump] : SUITS;
  const key = (id) => {
    const { suit, rank } = parseCard(id);
    if (suit === BIRD) return [SUIT_ORDER.length + 1, 99];
    return [SUIT_ORDER.indexOf(suit), -rank];
  };
  return ids.sort((a, b) => {
    const [sa, ra] = key(a);
    const [sb, rb] = key(b);
    return sa !== sb ? sa - sb : ra - rb;
  });
};
const tricksWonTotal = () => g.snapshot().tricksWon.reduce((a, b) => a + b, 0);

/* --------------------------------------------------------------- rendering */

function render() {
  const snap = g.snapshot();
  UI.updateHud(snap);
  UI.setSpotlight(actingSeat(snap));
  for (const s of [1, 2, 3]) UI.renderBacks(s, g.hands[s].length);
  renderHuman(snap);
  renderActions(snap);
  checkPhaseNarration(snap);
}

function actingSeat(snap) {
  if (snap.phase === 'bidding') return snap.currentBidder;
  if (snap.phase === 'contract_setup') return snap.contract ? snap.contract.seat : null;
  if (snap.phase === 'playing') return snap.currentPlayer;
  return null;
}

function renderHuman(snap) {
  const ids = handIds(HUMAN);
  const moves = g.legalMoves(HUMAN);
  if (snap.phase === 'contract_setup' && moves.turn && moves.needsDiscard) {
    UI.renderHumanHand(ids, {
      interactive: !busy,
      selected: selectedDiscards,
      incoming: nestIds,
      onCard: (_btn, id) => toggleDiscard(id),
    });
    return;
  }
  if (snap.phase === 'playing' && moves.turn) {
    UI.renderHumanHand(ids, {
      interactive: !busy,
      legal: new Set(moves.cards),
      incoming: nestIds,
      onCard: (_btn, id) => playCardFlow(HUMAN, id),
    });
    return;
  }
  UI.renderHumanHand(ids, { interactive: false, incoming: nestIds });
}

function renderActions(snap) {
  const moves = g.legalMoves(HUMAN);
  switch (snap.phase) {
    case 'pre_bid':
      UI.showPreBid(Boolean(moves.redeal), onBeginBidding, onDemandRedeal);
      break;
    case 'bidding':
      if (moves.turn) UI.showBidPanel(moves.bids, moves.canPass, onBid, onPass);
      else UI.showWaitNote(`Waiting for ${UI.SEAT_NAMES[snap.currentBidder]} to bid…`);
      break;
    case 'contract_setup': {
      if (moves.turn && moves.needsTakeNest) UI.showNestButton(onTakeNest);
      else if (moves.turn && moves.needsDiscard) {
        UI.showDiscardBar(onDiscardConfirm);
        UI.updateDiscardBar(selectedDiscards.size);
      } else if (moves.turn && moves.needsTrump) UI.showTrumpPanel(onTrump);
      else UI.showWaitNote(`Waiting for ${UI.SEAT_NAMES[snap.contract.seat]}…`);
      break;
    }
    case 'playing':
      if (snap.currentPlayer !== HUMAN) UI.showWaitNote(`Waiting for ${UI.SEAT_NAMES[snap.currentPlayer]}…`);
      else UI.clearActions();
      break;
    default:
      UI.clearActions();
  }
}

function checkPhaseNarration(snap) {
  if (snap.phase === lastPhase) return;
  const prev = lastPhase;
  lastPhase = snap.phase;
  if (snap.phase === 'contract_setup' && prev === 'bidding' && snap.contract) {
    const who = snap.contract.seat === HUMAN ? 'You' : UI.SEAT_NAMES[snap.contract.seat];
    const forced = snap.contract.allPassForced ? ' (forced — everyone passed)' : '';
    UI.announce(`Auction over: ${who} plays a ${snap.contract.bid} contract${forced}.`);
  } else if (snap.phase === 'playing' && prev === 'contract_setup') {
    UI.announce(`${UI.SUIT_NAMES[snap.trumpSuit]} is trump. ${UI.SEAT_NAMES[snap.leader]} leads.`,);
  }
}

/* ------------------------------------------------------------------ pump */

function pumpIfAi() {
  clearTimeout(pumpTimer);
  if (busy) return;
  const snap = g.snapshot();
  let aiTurn = false;
  if (snap.phase === 'bidding') aiTurn = AUTOPLAY || snap.currentBidder !== HUMAN;
  else if (snap.phase === 'contract_setup') aiTurn = AUTOPLAY || (Boolean(snap.contract) && snap.contract.seat !== HUMAN);
  else if (snap.phase === 'playing') aiTurn = AUTOPLAY || snap.currentPlayer !== HUMAN;
  if (aiTurn) pumpTimer = setTimeout(tick, T.ai);
}

function advance() {
  render();
  maybeEndScreens(g.snapshot());
  pumpIfAi();
}

function tick() {
  if (busy) { pumpTimer = setTimeout(tick, T.ai); return; }  // re-arm: never silently drop the chain (Review B #3)
  if (aiFailStreak >= 8) {
    console.debug('[rook]', 'AI pump stopped after repeated failures');
    UI.announce('The computer players are stuck. Use New game (or reload) to restart.');
    return;
  }
  const snap = g.snapshot();
  if (snap.phase === 'bidding' && (AUTOPLAY || snap.currentBidder !== HUMAN)) return aiBid(snap.currentBidder);
  if (snap.phase === 'contract_setup' && Boolean(snap.contract) && (AUTOPLAY || snap.contract.seat !== HUMAN)) return aiContractStep(snap.contract.seat);
  if (snap.phase === 'playing' && (AUTOPLAY || snap.currentPlayer !== HUMAN)) return aiPlay(snap.currentPlayer);
  advance();
}

/* ------------------------------------------------------------ AI actions */

function aiBid(seat) {
  const d = decideBid(g, seat);
  let ok = false;
  if (d.action === 'bid') {
    ok = tryEngine(() => g.bid(seat, d.amount), 'ai-bid');
    if (ok) { UI.announce(`${UI.SEAT_NAMES[seat]} bids ${d.amount}.`); Sfx.flip(); }
  }
  // Passing is always legal for the seat to act, so a rejected bid can never freeze the chain.
  if (!ok) {
    ok = tryEngine(() => g.pass(seat), 'ai-pass');
    if (ok) UI.announce(`${UI.SEAT_NAMES[seat]} passes.`);
  }
  if (ok) aiFailStreak = 0; else aiFailStreak++;
  advance();
}

function aiContractStep(seat) {
  const d = decideContract(g, seat);
  const name = UI.SEAT_NAMES[seat];
  let ok = false;
  let msg = '';
  if (d.action === 'takeNest') { msg = `${name} takes the nest.`; ok = tryEngine(() => g.takeNest(seat), 'ai-take-nest'); }
  else if (d.action === 'discard') {
    msg = `${name} discards five face down.`;
    const cards = (d.cards || []).map((c) => (typeof c === 'string' ? c : cardId(c)));
    ok = tryEngine(() => g.discard(seat, cards), 'ai-discard');
  } else if (d.action === 'callTrump') {
    msg = `${name} names ${UI.SUIT_NAMES[d.suit]} trump — play begins.`;
    ok = tryEngine(() => g.callTrump(seat, d.suit), 'ai-trump');
    if (ok) Sfx.flip();
  }
  if (!ok) {
    // Deterministic fallback driven by the engine's own legalMoves flags: always a legal
    // sub-step, so the pump can never spin forever on the same bad AI decision.
    ok = aiContractFallback(seat);
    if (ok) UI.announce(`${name} makes a safe contract move.`);
  }
  if (ok) aiFailStreak = 0; else aiFailStreak++;
  if (msg && ok) UI.announce(msg);  // tryEngine already announces failures itself
  advance();
}

function aiContractFallback(seat) {
  let mv;
  try { mv = g.legalMoves(seat); } catch (e) { return false; }
  if (mv.needsTakeNest) return tryEngine(() => g.takeNest(seat), 'ai-fallback-nest');
  if (mv.needsDiscard) {
    const five = g.hands[seat].slice().sort((a, b) => cardCounters(a) - cardCounters(b)).slice(0, 5).map(cardId);
    return tryEngine(() => g.discard(seat, five), 'ai-fallback-discard');  // shed lowest-counter cards
  }
  if (mv.needsTrump) return tryEngine(() => g.callTrump(seat, fallbackTrump(seat)), 'ai-fallback-trump');
  return false;
}

function fallbackTrump(seat) {
  const count = {};
  for (const c of g.hands[seat]) if (c.suit !== BIRD) count[c.suit] = (count[c.suit] || 0) + 1;
  let best = SUITS[0];
  let bestN = -1;
  for (const s of SUITS) { const n = count[s] || 0; if (n > bestN) { best = s; bestN = n; } }
  return best; // longest suit; ties favour the first suit — pure safety net, not strategy
}

function aiPlay(seat) {
  const d = decidePlay(g, seat);
  let card = d && d.card ? d.card : null;
  if (!card) {
    // Fallback: the engine's own first legal card guarantees trick progress.
    try {
      const mv = g.legalMoves(seat);
      card = mv.cards && mv.cards.length ? mv.cards[0] : null;
    } catch (e) { card = null; }
  }
  if (!card) { aiFailStreak++; advance(); return; }
  playCardFlow(seat, card);
}

/* ------------------------------------------------------------------- play */

function playCardFlow(seat, id) {
  if (busy) return;
  const before = g.snapshot().tricksWon.slice();
  const beforeSum = before.reduce((a, b) => a + b, 0);
  if (!tryEngine(() => g.playCard(seat, id), 'play')) { aiFailStreak++; advance(); return; }
  aiFailStreak = 0;
  Sfx.flip();
  trickIds.push(id);
  const node = UI.placeTrickCard(seat, id);
  trickNodes.push(node);
  const after = g.snapshot().tricksWon;
  const afterSum = after.reduce((a, b) => a + b, 0);
  if (afterSum > beforeSum) {
    const winner = after.findIndex((v, s) => v > before[s]);
    resolveTrick(winner);
  } else {
    advance();
  }
}

function resolveTrick(winner) {
  const pts = trickIds.reduce((n, id) => n + cardCounters(parseCard(id)), 0);
  const trickNo = tricksWonTotal();
  trickIds = [];
  const name = winner === HUMAN ? 'You take' : `${UI.SEAT_NAMES[winner]} takes`;
  const line = `Trick ${trickNo}: ${name} the trick${pts ? ` (+${pts})` : ''}.`;
  UI.addTrickLog(line);
  UI.bumpPile(winner);
  UI.announce(line);
  Sfx.trickWin();
  busy = true;
  const nodes = trickNodes.slice();
  trickNodes = [];
  // Linger: keep all four cards visible face-up long enough to read the whole trick.
  setTimeout(() => {
    Promise.all(nodes.map((n) => UI.collectTrick(n, winner, T.fly))).then(() => {
      busy = false;
      advance();
    });
  }, T.linger);
}

/* --------------------------------------------------------- human actions */

function onBeginBidding() {
  if (!tryEngine(() => g.startBidding(), 'start-bidding')) return;
  Sfx.flip();
  const snap = g.snapshot();
  UI.announce(`Bidding opens. ${snap.currentBidder === HUMAN ? 'You bid first.' : `${UI.SEAT_NAMES[snap.currentBidder]} bids first.`} Minimum 70, multiples of 5.`);
  advance();
}

function onDemandRedeal() {
  if (!tryEngine(() => g.demandRedeal(HUMAN), 'redeal')) return;
  Sfx.dealFlick();
  UI.announce('Redealt — same dealer shuffles again. Bidding opens now.');
  trickIds = [];
  trickNodes = [];
  UI.clearTrick();
  UI.resetPiles();
  UI.resetTrickLog();
  animateHandIn();
  advance();
}

function onBid(amount) {
  if (!tryEngine(() => g.bid(HUMAN, amount), 'human-bid')) return;
  Sfx.flip();
  UI.announce(`You bid ${amount}.`);
  advance();
}

function onPass() {
  if (!tryEngine(() => g.pass(HUMAN), 'human-pass')) return;
  UI.announce('You pass.');
  advance();
}

function onTakeNest() {
  let nest = null;
  if (!tryEngine(() => { nest = g.takeNest(HUMAN); }, 'take-nest')) return;
  nestIds = new Set((nest || []).map(cardId));
  for (let i = 0; i < 5; i++) defer(() => Sfx.dealFlick(), i * 90);
  const names = (nest || []).map((c) => UI.cardLabel(cardId(c))).join(', ');
  UI.announce(`Nest in hand: ${names}. Now pick exactly 5 cards to discard.`);
  advance();
}

function toggleDiscard(id) {
  if (busy) return;
  if (selectedDiscards.has(id)) selectedDiscards.delete(id);
  else if (selectedDiscards.size < 5) selectedDiscards.add(id);
  UI.updateDiscardBar(selectedDiscards.size);
  render();
}

function onDiscardConfirm() {
  if (selectedDiscards.size !== 5) return;
  const ids = [...selectedDiscards];
  if (!tryEngine(() => g.discard(HUMAN, ids), 'human-discard')) return;
  selectedDiscards.clear();
  nestIds.clear();
  Sfx.flip();
  UI.announce('You discard five face down. Now call trump.');
  advance();
}

function onTrump(suit) {
  if (!tryEngine(() => g.callTrump(HUMAN, suit), 'human-trump')) return;
  Sfx.flip();
  const snap = g.snapshot();
  UI.announce(`You play for ${snap.contract.bid} with ${UI.SUIT_NAMES[suit]} trump. ${UI.SEAT_NAMES[snap.leader]} leads.`);
  advance();
}

/* ------------------------------------------------------- hand/game edges */

function maybeEndScreens(snap) {
  if (snap.phase === 'hand_over' && settleShownFor !== snap.handNumber) {
    settleShownFor = snap.handNumber;
    UI.showSettlement(g.lastHandResult, snap, onNextHand);
    const r = g.lastHandResult;
    UI.announce(`Hand over. ${r.outcome === 'made' ? 'Contract made' : 'Contract failed'}. Scores are ${snap.scores[0]} to ${snap.scores[1]}.`);
    if (r.contractTeam !== HUMAN && r.outcome === 'failed') Sfx.bidFail();
  } else if (snap.phase === 'game_over' && !gameOverShown) {
    gameOverShown = true;
    UI.showWinner(snap.winner, snap);
    if (snap.winner === 0) Sfx.gameWin(); else Sfx.bidFail();
    UI.announce(snap.winner === 0
      ? `Game over — you and your partner win ${snap.scores[0]} to ${snap.scores[1]}!`
      : `Game over — opponents win ${snap.scores[1]} to ${snap.scores[0]}.`);
  }
}

function onNextHand() {
  UI.hideOverlays();
  if (!tryEngine(() => g.nextHand(), 'next-hand')) return;
  clearTimeout(pumpTimer);
  clearDeferrals();
  resetTrickState();
  animateHandIn();
  advance();
  UI.announce(`Hand ${g.handNumber} dealt. Look over your cards, then begin bidding.`);
}

function resetTrickState() {
  trickIds = [];
  trickNodes = [];
  selectedDiscards.clear();
  nestIds.clear();
  UI.clearTrick();
  UI.resetPiles();
  UI.resetTrickLog();
}

/* ------------------------------------------------------------------ deal */

function defer(fn, ms) {
  const t = setTimeout(() => { deferrals = deferrals.filter((x) => x !== t); fn(); }, ms);
  deferrals.push(t);
}
function clearDeferrals() {
  for (const t of deferrals) clearTimeout(t);
  deferrals = [];
}

function animateHandIn() {
  for (const s of [1, 2, 3]) UI.renderBacks(s, g.hands[s].length, true);
  UI.renderHumanHand(handIds(HUMAN), { interactive: false, deal: speedMode !== 'instant' });
  if (speedMode !== 'instant') {
    for (let i = 0; i < 13; i++) defer(() => Sfx.dealFlick(), i * T.stagger + T.stagger);
  }
}

function initGame() {
  clearTimeout(pumpTimer);
  clearDeferrals();
  g = createGame(SEED === null ? { target: 150 } : { target: 150, seed: SEED });
  settleShownFor = -1;
  gameOverShown = false;
  lastPhase = null;
  aiFailStreak = 0;
  resetTrickState();
  UI.hideOverlays();
  UI.updateHud(g.snapshot());
  animateHandIn();
  defer(() => {
    render();
    UI.announce('Cards dealt. Look over your hand, then begin bidding.');
  }, 13 * T.stagger + T.tail);
}

/* ------------------------------------------------------------------ boot */

setDebug(false);
if (AUTOPLAY || FAST || SEED !== null) console.debug('[rook]', 'drive params', { AUTOPLAY, FAST, SEED });

const unlockAudio = () => Sfx.unlock();
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

document.getElementById('mute-btn').addEventListener('click', () => {
  const muted = Sfx.toggleMuted();
  UI.setMuteButton(muted);
  if (!muted) Sfx.flip();
});
UI.setMuteButton(Sfx.isMuted());

/* rules dialog — opens with the game paused (busy), resumes on close */
const rulesEl = document.getElementById('rules');
const rulesCloseBtn = document.getElementById('rules-close-btn');
let rulesClaimedBusy = false;
const openRules = () => {
  if (!rulesEl.classList.contains('hidden')) return;
  if (typeof closeSpeed === 'function' && !speedEl.classList.contains('hidden')) closeSpeed();  // one dialog at a time
  rulesClaimedBusy = !busy;          // don't co-opt an in-flight trick/animation pause
  if (rulesClaimedBusy) busy = true;
  rulesEl.classList.remove('hidden');
  rulesCloseBtn.focus({ preventScroll: true });  // dialog should open at its TOP, not jump to the button
};
const closeRules = () => {
  if (rulesEl.classList.contains('hidden')) return;
  rulesEl.classList.add('hidden');
  if (rulesClaimedBusy) { busy = false; rulesClaimedBusy = false; advance(); }
};
document.getElementById('rules-btn').addEventListener('click', openRules);
rulesCloseBtn.addEventListener('click', closeRules);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRules(); });

/* speed dialog — same open→pause / close→resume pattern as the rules dialog */
const speedEl = document.getElementById('speed');
const speedBtn = document.getElementById('speed-btn');
const speedCloseBtn = document.getElementById('speed-close-btn');
let speedClaimedBusy = false;
function refreshSpeedUI() {
  speedBtn.textContent = `Speed: ${speedMode}`;
  for (const b of speedEl.querySelectorAll('[data-speed]')) {
    const on = b.dataset.speed === speedMode;
    b.classList.toggle('speed-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
function chooseSpeed(mode) {
  if (!SPEED_MODES.includes(mode)) return;
  speedMode = mode;
  lsSet(SPEED_KEY, mode);
  applySpeed();
  refreshSpeedUI();
}
const openSpeed = () => {
  if (!speedEl.classList.contains('hidden')) return;
  closeRules();                        // only one dialog at a time
  speedClaimedBusy = !busy;
  if (speedClaimedBusy) busy = true;
  speedEl.classList.remove('hidden');
  refreshSpeedUI();
  (speedEl.querySelector('.speed-on') || speedCloseBtn).focus({ preventScroll: true });
};
const closeSpeed = () => {
  if (speedEl.classList.contains('hidden')) return;
  speedEl.classList.add('hidden');
  if (speedClaimedBusy) { busy = false; speedClaimedBusy = false; advance(); }
};
speedBtn.addEventListener('click', openSpeed);
speedCloseBtn.addEventListener('click', closeSpeed);
for (const b of speedEl.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => chooseSpeed(b.dataset.speed));
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSpeed(); });
applySpeed();
refreshSpeedUI();

document.getElementById('play-again-btn').addEventListener('click', () => {
  UI.hideOverlays();
  initGame();
});

// fold hand/game screens into the render loop
initGame();
if (PARAMS.has('showrules')) openRules();   // hidden QA hook (after initGame, whose hideOverlays would close it)
if (PARAMS.has('showspeed')) openSpeed();   // hidden QA hook: speed menu screenshot

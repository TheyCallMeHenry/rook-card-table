/**
 * main.js — game flow orchestrator: state machine, AI pacing, wiring.
 * Engine is never modified: every engine call goes through tryEngine(),
 * which turns a RookError into an announcement instead of an exception.
 */
import { createGame, cardId, parseCard, cardCounters, setDebug } from './engine.js';
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
const AI_MS = FAST ? 80 : 700;             // pause between any two AI decisions
const DEAL_STAGGER = FAST ? 10 : 40;       // deal stagger in ms/card
const DEAL_TOTAL = 13 * DEAL_STAGGER + 320; // deal stagger + tail

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

const handIds = (seat) => g.hands[seat].map(cardId);
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
  if (aiTurn) pumpTimer = setTimeout(tick, AI_MS);
}

function advance() {
  render();
  maybeEndScreens(g.snapshot());
  pumpIfAi();
}

function tick() {
  if (busy) return;
  const snap = g.snapshot();
  if (snap.phase === 'bidding' && (AUTOPLAY || snap.currentBidder !== HUMAN)) return aiBid(snap.currentBidder);
  if (snap.phase === 'contract_setup' && (AUTOPLAY || snap.contract.seat !== HUMAN)) return aiContractStep(snap.contract.seat);
  if (snap.phase === 'playing' && (AUTOPLAY || snap.currentPlayer !== HUMAN)) return aiPlay(snap.currentPlayer);
  advance();
}

/* ------------------------------------------------------------ AI actions */

function aiBid(seat) {
  const d = decideBid(g, seat);
  let ok;
  if (d.action === 'bid') {
    ok = tryEngine(() => g.bid(seat, d.amount), 'ai-bid');
    if (ok) { UI.announce(`${UI.SEAT_NAMES[seat]} bids ${d.amount}.`); Sfx.flip(); }
  } else {
    ok = tryEngine(() => g.pass(seat), 'ai-pass');
    if (ok) UI.announce(`${UI.SEAT_NAMES[seat]} passes.`);
  }
  if (ok) advance();
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
  if (!ok) { advance(); return; }
  UI.announce(msg);
  advance();
}

function aiPlay(seat) {
  const d = decidePlay(g, seat);
  if (!d || !d.card) { advance(); return; }
  playCardFlow(seat, d.card);
}

/* ------------------------------------------------------------------- play */

function playCardFlow(seat, id) {
  if (busy) return;
  const before = g.snapshot().tricksWon.slice();
  const beforeSum = before.reduce((a, b) => a + b, 0);
  if (!tryEngine(() => g.playCard(seat, id), 'play')) { advance(); return; }
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
  Promise.all(nodes.map((n) => UI.collectTrick(n, winner))).then(() => {
    busy = false;
    advance();
  });
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
  for (let i = 0; i < 5; i++) setTimeout(() => Sfx.dealFlick(), i * 90);
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

function animateHandIn() {
  for (const s of [1, 2, 3]) UI.renderBacks(s, g.hands[s].length, true);
  UI.renderHumanHand(handIds(HUMAN), { interactive: false, deal: true });
  for (let i = 0; i < 13; i++) setTimeout(() => Sfx.dealFlick(), i * DEAL_STAGGER + DEAL_STAGGER);
}

function initGame() {
  g = createGame(SEED === null ? { target: 150 } : { target: 150, seed: SEED });
  settleShownFor = -1;
  gameOverShown = false;
  lastPhase = null;
  resetTrickState();
  UI.hideOverlays();
  UI.updateHud(g.snapshot());
  animateHandIn();
  setTimeout(() => {
    render();
    UI.announce('Cards dealt. Look over your hand, then begin bidding.');
  }, DEAL_TOTAL);
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

document.getElementById('play-again-btn').addEventListener('click', () => {
  UI.hideOverlays();
  initGame();
});

// fold hand/game screens into the render loop
initGame();

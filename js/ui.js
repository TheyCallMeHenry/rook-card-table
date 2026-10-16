/**
 * ui.js — pure DOM construction and rendering for the Rook table.
 * No game rules here: main.js owns state and calls these functions.
 * Imports read-only helpers from engine.js (never the other direction).
 */
import { cardCounters, parseCard } from './engine.js';

export const SEAT_NAMES = ['You', 'Opponent right', 'Partner', 'Opponent left'];
export const SUIT_NAMES = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Black', BIRD: 'Bird' };

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------- SVG glyphs */

 /** Suit glyphs, inline SVG (currentColor fill, dark stroke keeps yellow legible). */
export function svgSuit(suit, cls = '') {
  const stroke = 'stroke="rgba(0,0,0,0.45)" stroke-width="0.8"';
  const inner = {
    // Red: pointed flame-lozenge
    R: `<path d="M12 1.6 L19.4 12 L12 22.4 L4.6 12 Z" ${stroke}/>`,
    // Yellow: sunburst star
    Y: `<path d="M12 1.4l2.4 6.6 7.1-.5-5.2 5 1.7 6.9L12 15.9 6 19.4l1.7-6.9-5.2-5 7.1.5z" ${stroke}/>`,
    // Green: leaf-drop
    G: `<path d="M12 2C8.2 7 6 11 6 14.2a6 6 0 0 0 12 0C18 11 15.8 7 12 2z" ${stroke}/><path d="M12 9v9" stroke="rgba(255,255,255,0.5)" stroke-width="1.2" fill="none"/>`,
    // Black: spade
    B: `<path d="M12 2C9 7.2 4 9.2 4 13.1a4.6 4.6 0 0 0 7.1 3.8L10.4 20h3.2l-.7-3.1a4.6 4.6 0 0 0 7.1-3.8C20 9.2 15 7.2 12 2z" ${stroke}/><rect x="10.5" y="20" width="3" height="2.2" rx="1" ${stroke}/>`,
    // Bird: stylized rook perched, gold-trimmed card uses this
    BIRD: `<path d="M3 15c2-7 7.5-10.5 13.5-10.5h4.2l-2.2 3.4 2.4 1.2-3.4 3.2c0 4.4-3.4 8.4-8.7 9.7l1.2-4.4C6.5 16.9 4.4 16 3 15z" ${stroke}/><circle cx="16.4" cy="9.4" r="1" fill="#1d1608"/><path d="M13 22l1.6-3.6" stroke="rgba(0,0,0,0.45)" stroke-width="1.1" fill="none"/>`,
  }[suit] || '';
  const klass = `svg-suit s-${suit}${cls ? ' ' + cls : ''}`;
  return `<svg class="${klass}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/** Pretty label for a card id, screen-reader and text use. */
export function cardLabel(id) {
  if (id === 'BIRD') return 'the Rook bird';
  const rank = id.slice(1);
  return `${rank} of ${SUIT_NAMES[id[0]]}`;
}

/* ---------------------------------------------------------------- cards */

function cardFaceInner(id) {
  const parsed = parseCard(id);
  const isBird = id === 'BIRD';
  const pts = cardCounters(parsed);
  const cornerText = isBird ? svgSuit('BIRD') : `<span class="rank">${parsed.rank}</span>${svgSuit(parsed.suit)}`;
  const big = isBird ? svgSuit('BIRD') : svgSuit(parsed.suit);
  // Suit color lives on card-inner so EVERY consumer (hand, tricks, any future surface)
  // gets rank/glyph color even when the outer wrapper lacks an s-<suit> class.
  return `<span class="card-inner s-${parsed.suit}"><span class="card-face"><span class="corner">${cornerText}</span><span class="glyph">${big}</span>${pts > 0 ? `<span class="counter-tag">${pts}</span>` : ''}</span><span class="card-back3d"></span></span>`;
}

/**
 * A face-up card `<button>` for the human hand.
 * opts: { clickable, dim, selected, dealIndex, incoming, fan: {rot, dy} }
 */
export function cardEl(id, opts = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `card s-${id === 'BIRD' ? 'BIRD' : id[0]}${id === 'BIRD' ? ' card--bird' : ''}`;
  btn.dataset.id = id;
  btn.innerHTML = cardFaceInner(id);
  btn.setAttribute('aria-label', cardLabel(id));
  if (opts.fan) {
    btn.style.setProperty('--rot', `${opts.fan.rot}deg`);
    btn.style.setProperty('--dy', `${opts.fan.dy}px`);
  }
  if (opts.clickable === false) { btn.disabled = true; }
  if (opts.dim) btn.classList.add('card--dim');
  if (opts.selected) btn.classList.add('card--sel');
  if (opts.incoming) btn.classList.add('card--incoming');
  if (typeof opts.dealIndex === 'number') {
    btn.classList.add('card--deal');
    btn.style.setProperty('--i', String(opts.dealIndex));
  }
  return btn;
}

/** A face-down card back for AI seats. */
export function backEl(dealIndex) {
  const d = document.createElement('div');
  d.className = 'back';
  if (typeof dealIndex === 'number') {
    d.classList.add('back--deal');
    d.style.setProperty('--i', String(dealIndex));
  }
  return d;
}

/* --------------------------------------------------------------- mounts */

const ANNOUNCE = $('announce');
const handMount = () => $('hand-0');
const backsMount = (seat) => document.querySelector(`[data-backs="${seat}"]`);

export function announce(text) {
  ANNOUNCE.textContent = text;
}

/** Fan geometry for n held cards (bottom hand only). */
function fanFor(i, n) {
  const mid = (n - 1) / 2;
  return { rot: (i - mid) * 2.2, dy: Math.pow(i - mid, 2) * 0.45 };
}

/**
 * Render the human hand.
 * opts: { deal, legal:Set|null (ids clickable, others dim+disabled; null+interactive=all clickable),
 *         interactive:boolean, onCard(btn,id), selected:Set|null }
 */
export function renderHumanHand(ids, opts = {}) {
  const mount = handMount();
  mount.textContent = '';
  ids.forEach((id, i) => {
    let clickable = Boolean(opts.interactive);
    let dim = false;
    if (opts.legal) { clickable = opts.legal.has(id); dim = !clickable; }
    const btn = cardEl(id, {
      clickable,
      dim,
      selected: opts.selected ? opts.selected.has(id) : false,
      dealIndex: opts.deal ? i : undefined,
      incoming: opts.incoming ? opts.incoming.has(id) : false,
      fan: fanFor(i, ids.length),
    });
    if (clickable && opts.onCard) {
      btn.addEventListener('click', () => opts.onCard(btn, id));
    }
    mount.appendChild(btn);
  });
}

export function renderBacks(seat, count, deal = false) {
  const mount = backsMount(seat);
  mount.textContent = '';
  for (let i = 0; i < count; i++) mount.appendChild(backEl(deal ? i : undefined));
}

/* -------------------------------------------------------------- spotlight */

export function setSpotlight(seat) {
  for (let s = 0; s < 4; s++) {
    const el = $(`seat-${s}`);
    const on = s === seat;
    el.dataset.active = String(on);
    el.setAttribute('aria-active', String(on));
  }
}

/* --------------------------------------------------------------- seat tags */

/** Dealer / passed / high-bid chips on seat labels. */
export function updateSeatTags(snap) {
  for (let s = 0; s < 4; s++) {
    const mount = document.querySelector(`[data-tag="${s}"]`);
    const bits = [];
    if (snap.dealer === s) bits.push('<span class="tag tag-dealer">Dealer</span>');
    if (snap.phase === 'bidding' && snap.passed[s]) bits.push('<span class="tag tag-passed">Passed</span>');
    if (snap.phase === 'bidding' && snap.highBid && snap.highBid.seat === s) {
      bits.push(`<span class="tag tag-bid">${snap.highBid.amount}</span>`);
    }
    if ((snap.phase === 'contract_setup' || snap.phase === 'playing' || snap.phase === 'hand_over' || snap.phase === 'game_over')
      && snap.contract && snap.contract.seat === s) {
      bits.push(`<span class="tag tag-bid">${snap.contract.bid}</span>`);
    }
    mount.innerHTML = bits.join(' ');
  }
}

/* ------------------------------------------------------------------ HUD */

export function updateHud(snap) {
  $('hand-number').textContent = `Hand ${snap.handNumber} · first to ${snap.target}`;
  $('score-0').textContent = String(snap.scores[0]);
  $('score-1').textContent = String(snap.scores[1]);
  const pct = (v) => `${Math.max(0, Math.min(100, (v / snap.target) * 100))}%`;
  $('bar-0').style.width = pct(snap.scores[0]);
  $('bar-1').style.width = pct(snap.scores[1]);

  const bidBadge = $('badge-bid');
  bidBadge.classList.remove('badge--empty');
  if (snap.contract) {
    const who = snap.contract.seat === 0 ? 'you' : SEAT_NAMES[snap.contract.seat].toLowerCase();
    bidBadge.textContent = `Contract ${snap.contract.bid} — ${who}`;
  } else if (snap.highBid) {
    bidBadge.textContent = `High bid ${snap.highBid.amount} — ${SEAT_NAMES[snap.highBid.seat]}`;
  } else if (snap.phase === 'bidding') {
    bidBadge.textContent = `Auction open · min ${70}`;
  } else {
    bidBadge.textContent = 'No bid yet';
    bidBadge.classList.add('badge--empty');
  }
  const trumpBadge = $('badge-trump');
  if (snap.trumpSuit) {
    trumpBadge.className = `badge badge--trump s-${snap.trumpSuit}`;
    trumpBadge.innerHTML = `<span class="pill-glyph">${svgSuit(snap.trumpSuit)}</span>${SUIT_NAMES[snap.trumpSuit]} trump`;
  } else {
    trumpBadge.className = 'badge badge--empty';
    trumpBadge.textContent = '';
  }
  updateSeatTags(snap);
}

/* ------------------------------------------------------------- trick area */

const trickMount = () => $('trick-area');

export function clearTrick() {
  trickMount().textContent = '';
}

/** Place a played trick card at the trick-area offset for that seat. */
export function placeTrickCard(seat, id) {
  const wrap = document.createElement('div');
  wrap.className = 'trick-card';
  wrap.dataset.seat = String(seat);
  wrap.style.setProperty('--rot', '0deg');
  wrap.innerHTML = cardFaceInner(id);
  const size = { width: 'var(--card-w)', height: 'var(--card-h)' };
  wrap.style.width = size.width;
  wrap.style.height = size.height;
  trickMount().appendChild(wrap);
  return wrap;
}

/** Fly a face-up copy of the trick card to the winner's pile (no flip; cards stay readable). */
export function collectTrick(node, winnerSeat) {
  return new Promise((resolve) => {
    const rect = node.getBoundingClientRect();
    const pile = document.querySelector(`[data-pile="${winnerSeat}"]`);
    const target = pile.getBoundingClientRect();
    const clone = node.cloneNode(true);
    clone.classList.add('card--fly');
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.transform = 'none';
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      const dx = target.left + target.width / 2 - (rect.left + rect.width / 2);
      const dy = target.top + target.height / 2 - (rect.top + rect.height / 2);
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(0.32)`;
      clone.style.opacity = '0.35';
    });
    setTimeout(() => {
      clone.remove();
      node.remove();
      resolve();
    }, 480);
  });
}

export function bumpPile(seat) {
  const badge = document.querySelector(`[data-pile="${seat}"]`);
  badge.textContent = String(Number(badge.textContent) + 1);
  badge.classList.remove('pile-badge--pop');
  void badge.offsetWidth;             // restart the pop animation
  badge.classList.add('pile-badge--pop');
}

export function resetPiles() {
  for (let s = 0; s < 4; s++) document.querySelector(`[data-pile="${s}"]`).textContent = '0';
}

const trickLog = [];
export function addTrickLog(line) {
  trickLog.unshift(line);
  if (trickLog.length > 3) trickLog.pop();
  const ol = $('trick-log');
  ol.textContent = '';
  for (const t of trickLog) {
    const li = document.createElement('li');
    li.textContent = t;
    ol.appendChild(li);
  }
}
export function resetTrickLog() {
  trickLog.length = 0;
  $('trick-log').textContent = '';
}

/* ------------------------------------------------------------- action bar */

const bar = () => $('action-bar');

export function clearActions() {
  bar().textContent = '';
}

function panel() {
  const p = document.createElement('div');
  p.className = 'panel';
  return p;
}

export function showWaitNote(text) {
  clearActions();
  const p = panel();
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = text;
  p.appendChild(note);
  bar().appendChild(p);
}

export function showPreBid(canRedeal, onStart, onRedeal) {
  clearActions();
  const p = panel();
  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.textContent = 'Pre-bid';
  p.appendChild(title);

  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'btn';
  start.textContent = 'Begin bidding';
  start.addEventListener('click', onStart);
  p.appendChild(start);

  if (canRedeal) {
    const rd = document.createElement('button');
    rd.type = 'button';
    rd.className = 'btn btn-ghost';
    rd.textContent = 'Demand redeal (0 counters)';
    rd.addEventListener('click', onRedeal);
    p.appendChild(rd);
    const hint = document.createElement('p');
    hint.className = 'panel-note';
    hint.textContent = 'Your hand holds no counter cards — one redeal is allowed this hand.';
    hint.style.width = '100%';
    hint.style.textAlign = 'center';
    p.appendChild(hint);
  }
  bar().appendChild(p);
}

/** Bid ladder: one button per legal amount, plus PASS when legal. */
export function showBidPanel(bids, canPass, onBid, onPass) {
  clearActions();
  const p = panel();
  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.textContent = 'Your bid';
  p.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'bid-grid';
  for (const amount of bids) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = String(amount);
    b.addEventListener('click', () => onBid(amount));
    grid.appendChild(b);
  }
  p.appendChild(grid);

  if (canPass) {
    const pass = document.createElement('button');
    pass.type = 'button';
    pass.className = 'btn btn-pass';
    pass.textContent = 'Pass';
    pass.addEventListener('click', onPass);
    p.appendChild(pass);
  }
  bar().appendChild(p);
}

export function showNestButton(onTake) {
  clearActions();
  const p = panel();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = 'Take the nest (5 cards)';
  b.addEventListener('click', onTake);
  p.appendChild(b);
  bar().appendChild(p);
}

/** Discard-confirm bar; button disabled until exactly 5 are picked. */
export function showDiscardBar(onConfirm) {
  clearActions();
  const p = panel();
  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.textContent = 'Pick exactly 5 cards to discard';
  p.appendChild(title);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.id = 'discard-confirm';
  b.disabled = true;
  b.textContent = 'Discard 0 / 5';
  b.addEventListener('click', () => onConfirm());
  p.appendChild(b);
  bar().appendChild(p);
}

export function updateDiscardBar(count) {
  const b = $('discard-confirm');
  if (!b) return;
  b.textContent = `Discard ${count} / 5`;
  b.disabled = count !== 5;
}

export function showTrumpPanel(onPick) {
  clearActions();
  const p = panel();
  const title = document.createElement('h3');
  title.className = 'panel-title';
  title.textContent = 'Call trump — pick a color';
  p.appendChild(title);
  const label = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Black' };
  for (const suit of ['R', 'Y', 'G', 'B']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-suit suit-btn-${suit}`;
    b.innerHTML = `${svgSuit(suit)}${label[suit]}`;
    b.addEventListener('click', () => onPick(suit));
    p.appendChild(b);
  }
  bar().appendChild(p);
}

/* --------------------------------------------------------------- overlays */

export function showSettlement(lhr, snap, onNext) {
  const body = $('settlement-body');
  const teamNames = ['You & Partner', 'Opponents'];
  const madeIt = lhr.outcome === 'made';
  $('settlement-title').textContent = lhr.rene
    ? 'Hand over — rennee declared'
    : (madeIt ? `${teamNames[lhr.contractTeam]} made it!` : `${teamNames[lhr.contractTeam]} failed the bid`);

  const rows = [0, 1].map((t) => {
    const nestPts = lhr.nestAwardTeam === t ? lhr.nestCounters : 0;
    const dcls = lhr.deltas[t] >= 0 ? 'pos' : 'neg';
    const dtxt = `${lhr.deltas[t] >= 0 ? '+' : ''}${lhr.deltas[t]}`;
    return `<tr><td>${teamNames[t]}</td><td>${lhr.trickTeamTotals[t]}</td><td>${nestPts}</td>`
      + `<td>${lhr.teamTotals[t]}</td><td class="${dcls}">${dtxt}</td><td>${snap.scores[t]}</td></tr>`;
  }).join('');
  const declarer = lhr.contractSeat === 0 ? 'You' : SEAT_NAMES[lhr.contractSeat];
  const lastT = lhr.lastTrickTaker;
  const notes = [
    `Contract ${lhr.bid} by ${declarer} (${teamNames[lhr.contractTeam]}). ${lhr.outcome === 'made' ? 'Made — full counter total counts.' : 'Failed — bid subtracted in full.'}`,
    lastT !== null ? `${lastT === 0 ? 'You' : SEAT_NAMES[lastT]} took the last trick — ${teamNames[lhr.nestAwardTeam]} collect the nest (+${lhr.nestCounters}).` : 'Nest awarded via rennee void.',
  ];
  body.innerHTML = `<table class="settle-table">
      <tr><th>Team</th><th>Trick pts</th><th>Nest</th><th>Total</th><th>Change</th><th>Score</th></tr>
      ${rows}
    </table>
    <p class="settle-note">${notes.join(' ')}</p>`;
  $('settlement').classList.remove('hidden');
  $('next-hand-btn').onclick = onNext;
  $('next-hand-btn').focus();
}

export function showWinner(winner, snap) {
  $('winner-title').textContent = winner === 0 ? 'Victory!' : 'Defeat';
  $('winner-body').innerHTML = winner === 0
    ? `<p class="settle-note">You and your partner reach <strong>${snap.scores[0]}</strong> points against ${snap.scores[1]}. The table is yours.</p>`
    : `<p class="settle-note">The opponents reach <strong>${snap.scores[1]}</strong> points against your ${snap.scores[0]}. Shuffle up and try again.</p>`;
  $('winner').classList.remove('hidden');
  $('play-again-btn').focus();
}

export function hideOverlays() {
  $('settlement').classList.add('hidden');
  $('winner').classList.add('hidden');
  $('rules').classList.add('hidden');
}

/* ------------------------------------------------------------ mute toggle */

export function setMuteButton(isMuted) {
  const btn = $('mute-btn');
  btn.textContent = isMuted ? 'Sound: off' : 'Sound: on';
  btn.setAttribute('aria-pressed', String(isMuted));
}

/* ------------------------------------------------------------ fit canvas */

// The stage is a fixed 1360×820 scene; scale it to whatever screen appears.
const SCENE_W = 1360;
const SCENE_H = 820;
function fitScene() {
  const f = Math.min(window.innerWidth / SCENE_W, window.innerHeight / SCENE_H);
  document.documentElement.style.setProperty('--fit', String(f));
}
window.addEventListener('resize', fitScene, { passive: true });
fitScene();

# Rook — Card Table

Partnership Rook for one human vs three computer players: you and a partner against two opponents. Bid (70–120), grab the 5-card nest, call trump, and play the 13 tricks — first team to 150 wins.

**Play:** the site of this repository (GitHub Pages). No install, works in any modern browser, keyboard-navigable, sound toggle in the sidebar.

**Watch an AI game end-to-end:** add `?autoplay&fast&seed=7` to the URL.

Rook rules implemented: 57-card deck (four colors 1–14 + the Rook bird), bird = highest trump playable any time, 5s/10s/14s/bird are point cards (120 per hand), failed bid costs the full bid, nest discards score to the last-trick winner.

Single static HTML/CSS/JS app — no build step, no dependencies. Cards are inline SVG, the table is CSS gradients, sounds are synthesized in WebAudio.

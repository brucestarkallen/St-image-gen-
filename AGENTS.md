# SceneSnap — agent notes

## Gate (run all before any push; every command must exit 0)

```bash
cp index.js /tmp/ss_gate.mjs && node --check /tmp/ss_gate.mjs   # ESM parse (node --check on .js parses CommonJS — always check a .mjs copy)
node test.mjs                                                    # behavior harness; exit 1 on any failure
npx -y eslint@9 index.js test.mjs                                # lint (config is import-free; no install needed)
```

Negative-test any NEW guard by reintroducing its bug in a scratch copy and proving the harness fails:

```bash
cp index.js /tmp/broken.js   # then delete the guard line in /tmp/broken.js
SS_SRC=/tmp/broken.js node test.mjs   # MUST exit 1
```

Version discipline: `manifest.json` version and the `const VERSION` stamp in `index.js` must match — the harness asserts it. Bump on every push; changelog entry in README with every change.

## Architecture (index.js, single file)

- **Builder transport ladder** (`callLLM`): Connection Manager profile → `ctx.generateRaw({prompt, systemPrompt})` → `generateQuietPrompt`. generateRaw is the preset-free path: a quiet prompt runs through the full generation pipeline, so a heavy RP preset (laws, CoT) contaminates builder output. Never reorder this ladder.
- **Grounding** (`collectSceneGrounding`): presence markers `[IST: name|state]` / `[ACW: name|...]` from the newest message that prints them (walk-back 6, same defaults as Summaryception; its user-configured patterns are respected when set), per-character `state` from `chatMetadata.summaryception.ledger`, and 500-char tails of the two preceding turns. All sources degrade to nothing without error — grounding is fuel, never a dependency. Pure cores (`scanPresenceIn`, `markerDetails`, `ledgerStateLines`) are separated from ctx wrappers for testability.
- **Dialogue bubbles**: builder returns `bubbles:[{speaker,text}]` per panel (JSON mode); `sanitizeBubbles` enforces the **verbatim guarantee** — a bubble renders only if its text literally occurs in the scene (normalized for curly quotes/case/whitespace). Verify FIRST, length-trim SECOND. Cap 2/panel, 90 chars. `overlayBubbles` draws them on canvas (backend-agnostic, pixel-legible); overlay failure ships the clean panel, never kills the image. Recovery paths (truncated JSON) drop bubbles rather than risk unverified text.
- **Backends**: runware (WS), novelai via ST route, novelai multi-char via direct API (zip extract), pollinations. Multi-char is single-frame; bubbles apply there via top-level `bubbles` key.
- **Canonical prompt constants**: `BUBBLE_RULES` and `GROUNDING_RULE` are single sources cited by both builder paths — never restate their content elsewhere.

## Invariants

1. Invented dialogue can never reach an image (verbatim guarantee — negative-tested). Bubble text also never ends mid-sentence: whole ≤110, sentence-boundary cut, or word-cut + ellipsis (negative-tested). Two bubbles render side-by-side in the top band only.
1a00. World consistency is DATA + CODE, not instructions: builder emits top-level `dress`/`setting` tag lists once; appendAnchor stamps them (deduped) onto every panel; mineDressTags(cast) is the deterministic backstop. Never regress to per-panel prompt instructions for world consistency — that was the drift bug. Autonomy principle: the user never pastes world facts the extension can derive.
1a0. Panel discipline is contract text in the sequence prompt: 2-character cap, count tags first, full cast tags per character, no role-word clothing, one crowd emotion, speaker faces audience, concrete single-tag actions. These are prompt-level (world knowledge lives in cast tags + Extra builder rules, never hardcoded — model/world-agnostic).
1a. Panel prompts are single frames: layout meta-language (comic/panel/page/grid/multiple views) is contractually banned in the builder prompt and deterministically scrubbed by stripLayoutMeta (negative-tested). SceneSnap media entries carry `scenesnap: true` and their messages get `.scenesnap-media` (append + CHAT_CHANGED + APP_READY) so style.css can lift ST's 40vh cap — keep flag and class in sync.
1b. Sequence mode (Max panels ≥ 2) is a strip contract: the builder prompt floors at 2 panels, panels generate landscape (getSize(landscape) flip), all panels share ONE run seed (never per-panel random — that re-rolls the characters), the outfit contract repeats full appearance tags verbatim per panel, and stitching cover-fills identical black-framed cells.
2. NOTHING breaks image generation: bubbles and grounding are best-effort layers over the standard single-prompt route — the button never returns empty while that route works. (NAI multi-character mode was removed in 0.10.0: never verified end-to-end, transport dead on the field device across clean browsers; do not resurrect without a full live verification of the final NovelAI hop.)
3. Bubbles OFF means zero bubbles regardless of what the builder returns (gating — negative-tested).
4. Presets and briefs stay model-agnostic; nothing assumes a specific text or image model beyond declared backend prompt styles.
5. Sheetless generation is allowed but never silent (one warning per chat).
6. Every backend HTTP call is same-origin — an ST API route or ST's `/proxy/<url>` CORS proxy. Direct cross-origin `fetch()` is forbidden: the browser blocks it (no CORS headers on NAI et al.) and it fails as an opaque "Failed to fetch" — the exact 0.7.0 multi-char defect. WebSocket backends (Runware) are exempt (no CORS preflight). The harness asserts no direct NovelAI fetch exists. Corollary: a browser-level fetch failure can only mean the ST server is unreachable, and `explainError` (the single reporter path) translates it to say so — keep both sides of that invariant in sync.
7. HTTP failures with a known cause and a one-step fix are classified by pure, negative-tested guards and answered with the fix, never the raw body. Currently: stale page session after an ST restart (403 + 'invalid csrf token' → reload), and browser-level fetch death (→ ST unreachable via explainError). When adding one, capture the real body from a live server first.
8. Third-party URLs are always percent-encoded when embedded in a request path (`/proxy/${encodeURIComponent(url)}`): raw embedded `https://` matches content-blocker circumvention filters and invites path normalization. Express decodes params, so the server sees the same URL either way — verified live.

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

1. Invented dialogue can never reach an image (verbatim guarantee — negative-tested).
2. Bubble/grounding features can never break image generation (every failure degrades to the clean-panel / ungrounded path).
3. Bubbles OFF means zero bubbles regardless of what the builder returns (gating — negative-tested).
4. Presets and briefs stay model-agnostic; nothing assumes a specific text or image model beyond declared backend prompt styles.
5. Sheetless generation is allowed but never silent (one warning per chat).
6. Every backend HTTP call is same-origin — an ST API route or ST's `/proxy/<url>` CORS proxy. Direct cross-origin `fetch()` is forbidden: the browser blocks it (no CORS headers on NAI et al.) and it fails as an opaque "Failed to fetch" — the exact 0.7.0 multi-char defect. WebSocket backends (Runware) are exempt (no CORS preflight). The harness asserts no direct NovelAI fetch exists.

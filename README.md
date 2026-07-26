# SceneSnap (Scene Illustrator)

Automatic scene illustrations for immersive long-form RP. After each AI message, SceneSnap converts the **final beat of the scene** into a proper image prompt and attaches the result to the **end of that message** — non-blocking, so you read the prose while the image cooks.

```
Extensions -> Install from URL -> https://github.com/brucestarkallen/St-image-gen-
```

Requires a recent SillyTavern release (uses the modern `extra.media` message attachment system).

## Why images usually come out wrong (and how SceneSnap fixes it)

Generic image extensions dump raw chat prose into the image model. Three things break:

1. **Character drift** — the model reinvents hair/eye/outfit every image. SceneSnap keeps a **cast sheet**: locked appearance tags per character, injected verbatim into every prompt.
2. **Scene mashing** — prose contains headers, trackers, memories, and multiple beats; the image tries to depict all of it at once. SceneSnap's builder is instructed to pick **one frozen frame: the final visual beat**, and to treat header/tracker blocks (timeline, current clothes) as **authoritative outfit/setting data**, not scene content.
3. **Blind builder** — a single message rarely restates where everyone is, what they're wearing, or who's even in the room; the builder guesses from pronouns and invents the rest. SceneSnap now grounds every prompt in **current world state**: the preset's `[IST: name|state]` / `[ACW: ...]` presence markers (authoritative attendance — off-screen characters are forbidden), Summaryception's per-character ledger `state` (location, condition, activity), and short tails of the two preceding turns for pronoun resolution.
4. **Prompt-format mismatch** — anime checkpoints (Illustrious / NoobAI / NovelAI) want **Danbooru tags**; FLUX-style models want **natural language**. Feeding one the other's format produces mush. SceneSnap auto-matches prompt style to the backend.

## Pipeline

```
AI message rendered
   └─ scene text (top header kept + final ~70% kept)
      + active cast sheet
      + world state (presence markers + Summaryception ledger) + preceding-turn tails
      + your extra rules
   └─ Prompt builder LLM (profile → generateRaw → quiet prompt, preset-free where possible)
      → tags / natural prompt for one frozen frame (+ verbatim dialogue picks)
   └─ Image backend → dialogue bubbles drawn on → saved to chat files → attached to the message
```

Generation runs after the message renders. It never delays text generation. The paintbrush icon on the message shows an hourglass while working; multiple images per message become a swipeable gallery.

## Backends

| Backend | Prompt style | Setup | Notes |
|---|---|---|---|
| **Runware** (recommended) | Danbooru tags | API key + model AIR | Runs any Civitai checkpoint (Illustrious/NoobAI family) at sub-cent cost, typically 1–3 s per image. Get the AIR from the model page sidebar on Civitai, e.g. `civitai:XXXXXX@XXXXXXX`. |
| **NovelAI** | Danbooru tags | NovelAI key set in ST's API Connections | V4.5 Full is the strongest anime model available; Opus sub = effectively unlimited standard-size gens. Steps capped at 28 to stay in the free-generation band. |
| **Pollinations** | Natural language | None | Free, zero-config. Use it to test the pipeline before paying for anything. Quality/consistency below the other two. |

Good starting checkpoints for Runware: any high-rated **Illustrious XL** or **NoobAI-XL** merge on Civitai. Community-recommended params are already the defaults (steps ~26, CFG 5, clip skip 2). Leave scheduler blank unless you know the model prefers `Euler a`.

## NovelAI multi-character mode (the accuracy upgrade)

This is what closes the gap between a hand-made NAI web-UI image and an automatic one. Instead of cramming every character into a single prompt (which causes trait-bleed — the wrong person gets the wrong hair/eyes), it sends **each named character in the scene as a separate NAI character panel**: a base prompt for the scene/crowd/composition, plus one appearance-only prompt per person, positioned across the frame. Exactly the structure that produces clean multi-person images in NovelAI's own UI.

**Enable it:**
1. Backend = NovelAI.
2. Turn on **Multi-character mode**.
3. Paste a **persistent token** (NovelAI → User Settings → Account → Get Persistent API Token — this is separate from the key SillyTavern uses).
4. Have a **cast sheet** with the characters (auto-build fills it from story memory).

When active, the builder emits a base scene prompt plus one panel per named character physically present in the final frame (max 4; extras fold into the crowd). Quality tags live only in the base; each panel is pure appearance + current action. It's single-frame only — comic sequence mode applies to the other backends. If the token or cast sheet is missing, it silently falls back to the normal single-prompt path.

Check **Show last generation** to see the exact base prompt and per-character panels that were sent.

## Comic sequence mode

Set **Max panels** to 2–4 and the builder decides *per scene* whether the climax is one frozen frame or a sequence of distinct beats (a liver shot → the fold → the collar grab), keeping character tags identical across panels. Panels are generated back-to-back and stitched into a single comic strip (2–3 side by side, 4 in a grid). Default is 1 — behavior unchanged unless you raise it.

## Dialogue bubbles (the comic-text upgrade)

On by default. The builder picks up to two spoken lines per panel — **copied verbatim from the scene** — and SceneSnap draws them onto the image as manhwa-style floating bubbles (first top-left, second top-right, in speech order). Because SceneSnap renders the text itself on canvas, it is pixel-legible on **every** backend and can never come out model-garbled — no dependence on any image model's typography lottery.

The verbatim guarantee is enforced, not requested: a line the builder returns is dropped unless it literally occurs in the scene text (curly quotes, case, and whitespace normalized). Invented dialogue can never reach an image. If a beat has no dialogue, the panel ships clean. Overlay failures also ship the clean panel — bubbles can never cost you the image. Pair with **Max panels 2–4** for the full stacked-strip look.

## World-state grounding

Every builder call now carries an authoritative `CURRENT WORLD STATE` block when the data exists: who is **on screen** (from the newest `[IST: ...]` markers within the last 6 messages — off-screen `[ACW: ...]` names are forbidden from the frame), each present character's current location/condition/activity (marker detail + Summaryception's ledger `state`), plus reference-only tails of the two preceding turns so pronouns, place, and outfits resolve correctly. Custom Summaryception marker patterns are respected. Every source degrades silently to nothing — grounding is fuel, never a dependency.

The builder itself also got a cleaner transport: with no Connection Manager profile set, it now uses `generateRaw` (current connection, **no chat history, no active preset**) instead of a quiet prompt, so a heavy RP preset's laws and chain-of-thought no longer contaminate the image prompt. Quiet prompt remains as last-resort transport only.

## NovelAI notes

- Model: `nai-diffusion-4-5-full`. With NAI, consider quality tags `very aesthetic, masterpiece, no text` instead of the Illustrious block, and keep the negative prompt — NAI uses it well.
- Ceiling: SillyTavern's server route sends only the base prompt to NAI and hardcodes the per-character fields (`char_captions`) to empty — so V4.5's true multi-character mode (separate prompt per character, zero trait bleed) is unreachable through stock ST. A ~3-line server patch forwards them; direct-API mode is a planned alternative.

## Cast sheets

One line per character:

```
Jovan: boy, short black hair, red eyes, tall, lean build, academy uniform
Stella: girl, long crimson hair, red eyes, large breasts, hair ribbon, school uniform
```

- **Auto-build cast** reads long-term story memory first — Summaryception's canon notepad and layered summary snippets (personal forks included), plus the Author's Note — then falls back to recent chat for characters memory hasn't captured yet. Always review the result.
- **Auto-bootstrap**: with "Auto-build cast when empty" on, the first illustration in a chat builds the sheet automatically from story memory before generating, and degrades gracefully (continues sheetless) if it fails.
- Casts are global; each chat remembers which cast is active — so one cast per story world, shared across all its chats.
- Only characters *visible in the final frame* get pulled into a prompt.

## Settings that matter

- **Prompt builder LLM**: pick a *fast* Connection Manager profile. The builder call is ~500 tokens out; a fast model keeps image latency low. Falls back to your main API if unset.
- **Strip from scene**: regexes (one per line) removed from the message before prompt building. Defaults already cover `<details>` blocks, `{ALLCAPS}...{/ALLCAPS}` tracker blocks, and HTML comments — so stat trackers at the end of a message never displace the final prose beat.
- **Dialogue bubbles**: on/off for the comic-text overlay. Lines not found word-for-word in the scene are dropped, never invented.
- **Extra builder rules**: story-agnostic constraints, e.g. `Never depict more than 2 characters` or `Interior scenes: always include window lighting`.
- **Always-append quality tags / Negative prompt**: standard Illustrious/NoobAI quality block is prefilled.
- **/snap** — illustrate the last AI message. **/snap 42** — illustrate message #42. Paintbrush icon on any AI message does the same.
- **Reset defaults** restores the tuned baseline (steps/CFG, sizes, prompt style, quality/negative blocks) while keeping your API key, Runware model, cast sheets, extra rules, builder profile, and backend choice.

## Troubleshooting

- **"Prompt builder returned an empty response"** — the profile model may be reasoning-only or unreachable; pick another profile or leave on Main API.
- **Runware "invalid model"** — re-copy the AIR from Civitai; version IDs change when models update.
- **NovelAI 401** — set your NovelAI key under API Connections (NovelAI) first.
- **"Something in this browser blocked the image request"** — the server answered a liveness probe, so the multi-char request was killed inside the browser itself: an ad/privacy shield or content blocker (common on mobile browsers with built-in blocking). Allow this SillyTavern address in the blocker. SceneSnap ships a single-prompt image in the meantime.
- **"This page is older than the SillyTavern server"** — ST was restarted after this tab loaded, so its session died and ST rejects every call until the page is reloaded. One reload fixes it.
- **"SillyTavern's server didn't answer"** — the button was pressed while ST was restarting or down. The page stays open but its server is gone, so every call fails instantly. Wait for the startup banner, reload the page, press again. (Since 0.8.1 all requests are same-origin, so this is the only thing a browser-level fetch failure can mean.)
- **Multi-char warns that the CORS proxy is off** — NovelAI's API refuses direct browser calls, so multi-character mode rides SillyTavern's proxy route. One line in `config.yaml`: `enableCorsProxy: true`, restart ST (or launch with `--corsProxy`). Until then SceneSnap ships a single-prompt image instead of failing.
- **A bubble is missing** — the builder's line wasn't found verbatim in the scene (dropped by design), or the beat had no dialogue. **Show last generation** lists every accepted bubble.
- **Wrong characters keep appearing** — check the cast sheet and whether your preset prints `[IST: ...]` markers; with markers present, off-screen characters are hard-barred from prompts.
- **Auto mode fired on an old message** — it only targets the newest AI message and suppresses itself for a moment after chat switches; if you see otherwise, report the console log.

## Changelog

### 0.8.4
- **Multi-char proxy URL is now percent-encoded** (`/proxy/https%3A%2F%2F...`). A raw `https://` embedded in a request path is the exact shape content/privacy blockers kill as "proxy circumvention", and some stacks normalize the double slash; the encoded form is byte-identical server-side (verified against a live ST) and gives filters nothing to match.
- **Fetch deaths are measured, not assumed**: if the proxy request dies at browser level, SceneSnap probes `GET /version`. Server up → "a blocker in this browser killed the request" (and falls back to single-prompt so the image still ships). Server down → the existing unreachable message. No more guessing which one it was.

### 0.8.3
- The full multi-char pipeline was verified against a live SillyTavern instance: request routing through `/proxy/`, CSRF, Authorization forwarding, and byte-perfect binary zip piping into SceneSnap's extractor; the disabled-proxy detector was validated against ST's real response.
- **New classified failure**: pressing the button on a page left open across an ST restart fails ST's CSRF gate with an HTML 403. All three backends now detect it and say the actual fix ("reload the page") instead of printing raw HTML.

### 0.8.2
- Browser-level fetch failures ("Failed to fetch" / "NetworkError" / "Load failed") are now translated at the single error reporter into what they actually mean — the SillyTavern server didn't answer (restarting or down) — in the toast and in **Show last generation**. Valid since 0.8.1 made every request same-origin, which the gate asserts.

### 0.8.1
- **Fixed: multi-character mode failed with "Failed to fetch".** Root cause: v0.7.0 called `image.novelai.net` directly from the browser, and NovelAI's API sends no CORS headers, so the browser kills the request before it leaves. Multi-char now rides SillyTavern's same-origin CORS proxy route (`enableCorsProxy: true` in config.yaml). When the proxy is off, SceneSnap detects ST's exact disabled-proxy response, warns once with the config line, and degrades to a single-prompt image — same ladder as a missing token or cast. Token-rejection errors now surface NovelAI's own message (ST rewrites upstream 401s to 400; both are handled).

### 0.8.0
- **Dialogue bubbles**: verbatim scene dialogue drawn onto panels as manhwa-style bubbles by SceneSnap itself — legible on every backend, enforced verbatim (invented lines are dropped, never rendered), max 2 per panel, graceful degradation everywhere.
- **World-state grounding**: builder prompts now carry authoritative attendance from `[IST:]`/`[ACW:]` presence markers (walk-back 6 messages, custom Summaryception patterns respected), per-character location/condition from Summaryception's ledger `state`, and preceding-turn tails for pronoun resolution.
- **Preset-free builder fallback**: Main-API path now uses `generateRaw` (no chat, no preset) before falling back to a quiet prompt — RP preset laws/CoT no longer contaminate image prompts.
- **Sheetless generation warns** once per chat instead of silently losing appearance locking.
- Gate established: ESM parse check, `test.mjs` behavior harness (36 checks, negative-tested guards), ESLint config. `AGENTS.md` added.

### 0.7.0
- NovelAI multi-character mode, comic sequence mode, cast auto-build from story memory, Runware/NovelAI/Pollinations backends.

## License

MIT

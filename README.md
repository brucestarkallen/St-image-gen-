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

Set **Max panels** to 2–4 and the builder decides *per scene* whether the climax is one frozen frame or a sequence of distinct beats (a liver shot → the fold → the collar grab), keeping character tags identical across panels. Panels are generated back-to-back and stitched into a single vertical strip — identical framed cells, printed-comic gutters, top-to-bottom read. Default is 1 — behavior unchanged unless you raise it.

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
- **"This page is older than the SillyTavern server"** — ST was restarted after this tab loaded, so its session died and ST rejects every call until the page is reloaded. One reload fixes it.
- **"SillyTavern's server didn't answer"** — the button was pressed while ST was restarting or down. The page stays open but its server is gone, so every call fails instantly. Wait for the startup banner, reload the page, press again. (Since 0.8.1 all requests are same-origin, so this is the only thing a browser-level fetch failure can mean.)
- **A bubble is missing** — the builder's line wasn't found verbatim in the scene (dropped by design), or the beat had no dialogue. **Show last generation** lists every accepted bubble.
- **Wrong characters keep appearing** — check the cast sheet and whether your preset prints `[IST: ...]` markers; with markers present, off-screen characters are hard-barred from prompts.
- **Auto mode fired on an old message** — it only targets the newest AI message and suppresses itself for a moment after chat switches; if you see otherwise, report the console log.

## Changelog

### 0.14.0 — the counts stop lying, and scenery stops eating subject slots
- **Fixed: crowds rendered as gray shapeless mass, and principals vanishing from packed frames.** Danbooru count tags are an exhaustive claim about a frame's population — `1boy, 1girl` asserts a two-person world. The extension stamped those counts on every panel while the same panel's anchor named a courtyard of three hundred, and the image model resolved the contradiction the only way it could: everyone not counted came out as non-people, or a counted principal was dropped to make the number true. Counts are now crowd-aware — when the frame's own text puts a crowd in it, the count block says so, and the crowd becomes something the model is asked to draw rather than something it is told does not exist.
- **Fixed: a figure standing across the courtyard consumed a full subject slot.** A `who` entry whose own state placed it far away, tiny, or seen from behind at a distance still received the full verbatim appearance block and a principal's count — the model split its attention between a foreground face and a background speck and degraded both. Background figures are now demoted out of `who` before the weld and named in the prompt as an environment element; the law says so explicitly, and a frame is never left with zero subjects.
- **Fixed: a panel could carry a line shouted by someone it never drew.** `sanitizeBubbles` never received the panel's `who`, so the speaker's-face law was unenforceable by construction — a balloon could point at nobody. It now takes `who` and drops any line whose speaker is not a principal in that frame.
- **Fixed: appearance blocks arriving twice.** A builder that restated appearance without commas ("tall lean sharp-featured") produced one token matching no single cast tag, so exact-token scrubbing passed the whole block through a second time. Scrubbing now compares word sets; action tags that merely reuse an appearance word ("white hair blowing in wind") still survive.
- **Two principals in one frame must share one interaction**, and `setting` is a standing description — never what the crowd is momentarily doing. A transient verb there ("dispersing crowd") is stamped unchanged onto every panel and contradicts all of them.
- **Removed a rule the code could not honor:** the laws told the builder that three or more in `who` get automatic placement tags, but the two-cap slices `who` to two at parse, so that branch was unreachable. Dead code and dead rule both gone; the cap is now uniform in `assembleIdentity` too.
- Gate: 146 → 157 checks; all eight new guards negative-tested.

### 0.13.0 — identity is code in EVERY mode
- **Fixed: cast names containing "t" leaked into composition sentences.** The name-escape class had stray letters spliced into it, so any such name compiled to a regex demanding literal tab characters and silently never matched — "Matsumoto", "Hitsugaya", "Kotetsu" all rode into sentences verbatim, violating the names-are-semantic-zeros contract. Escaping now lives in one canonical top-level `escRe` helper (nested-template mangling is structurally impossible), it is behavior-tested against metacharacters and bracketed names (an unescaped `[` threw and killed the whole generation), and role words are now faithful to the sheet's gender word — a `boy` reads "the boy" in the sentence, never "the man".
- **Single frames get the full structured contract.** With a cast sheet present (tags style), Max panels = 1 now sends the same `who`/`state`/`sentence`/`setting`/`dress` JSON schema as sequence mode: identity welded verbatim by code, states bound to their owners, shot grammar + acting density mandated, the world anchor stamped, the composition sentence riding at the end. Before this, single-frame identity was builder-written — every identity bug class the who-weld was built to kill still lived in the default mode.
- **Fixed: one wasted builder call on every default-mode image.** The who-compliance retry demanded a schema that single-frame prompts never sent, so each single-frame generation with a cast burned a second, contradictory builder call — and whichever output happened to include `who` won, coin-flipping between two identity regimes. The retry now fires only when the schema was actually sent, and Show last generation says "(single frame — builder-written identity)" instead of falsely accusing the builder when it wasn't.
- **One canonical `FRAME_LAWS` block** now carries the per-frame laws (who-weld, two-cap, shot grammar, acting density, sentence, clothing-from-cast-only, crowd, effect ownership, WORLD data contract), cited by both builder modes — strip-specific rules (chronology, continuity, panel-splitting, camera variation) stay in sequence mode. No restatement, no drift.
- **Hardening:** overlong `who` states are cut at a tag boundary, never mid-word; a panel object without a `prompt` is dropped instead of becoming a literal "[object Object]" prompt; `multiple boys/girls` count tags keep their space instead of squishing into an invalid token; gender words are detected by word boundary, so `young man` / `old woman` sheet lines count and read correctly.
- Gate: 127 → 146 checks; all seven new guards negative-tested (each bug reintroduced in a scratch copy must fail the harness, proven).

### 0.12.8
- **Placeholder lines are empty slots, not entries.** `(appearance unknown — fill in)` no longer blocks anything: it counts as missing at assembly (junk tags can never enter a prompt), the cast author no longer sees it in the skip-list, and merging replaces it with the real line. The snap button heals them itself — from the wiki cache, story text, or canon knowledge — with zero manual steps, including no deleting.

### 0.12.7 — the wiki feeds the cast
- **Canon Grounding integration.** SceneSnap's cast author now reads the sibling Canon Grounding extension's cache (`chatMetadata.canon_grounding_cache`) — the fandom wiki's extracted appearance text per character — as the PRIMARY appearance source, converted faithfully into danbooru tags. Fully automatic, read-only, guarded.
- **Canon characters are never "unknown".** Source order is law: wiki data → story text → the builder's own canonical knowledge for established fandom characters. `(appearance unknown — fill in)` is reserved strictly for original characters no source describes.
- Doctrine recorded: manual sheet edits are never the suggested fix — the automatic chain (wiki → author → per-chat seeding → one-line-delete refresh) is the system.

### 0.12.6
- **No more subject-less panels.** A who-name missing from the cast used to ship a prompt with zero people in it — an empty courtyard where a character belonged. Missing names now trigger one targeted cast-seeding (the builder must output lines for exactly those characters from story memory) before assembly.
- **Sentences speak in role words, enforced in code**: any cast name leaking into a composition sentence is substituted with the character's gender word — names are semantic zeros to tag-native models.
- **Dress-derived anti-modern negative**: when the world's declared dress is traditional and nothing modern is declared, the negative prompt automatically gains modern-uniform terms — seeds can no longer outvote the kosode with Prussian tunics. World-agnostic: it only fires on what your own world data says.

### 0.12.5
- **Subject-derived panel seeds.** The locked strip seed kept recurring characters consistent but bled palette priors across *different* subjects — two white-haired solo panels primed the next panel's black-haired girl silver. Seeds now derive from who is in the frame: same people → same seed, different people → decorrelated. Negative-tested.
- **Dialogue beats are two-shots**: a line spoken to a present character puts speaker AND addressee in `who` (or a shot/reverse pair); solo frames are for reactions and genuine solitude — defaulting to solo is a failed strip.
- **Bubbles show the speaker's face**: dialogue may never ride a from-behind, neck-down, or faceless framing of its own speaker.
- **Crowd dress is named in setting** — an unnamed crowd's dress is how background people modernize.

### 0.12.4 — the gold run, decoded and mandated
- The user's best-ever strip was reverse-engineered: it was beautiful because frames were solo/duo (binding held — now law via the two-cap) and every panel was drenched in cinematic grammar. That grammar is now **contract**: every panel carries exactly one framing tag + one angle tag + lighting/atmosphere, consecutive panels never repeat the same framing+angle pair, and every character's state must be 4–8 acting tags (pose + expression + gaze + one physical emotive detail). Terse states are failed panels.
- **One world, one cast.** The active cast is now a plain global setting; per-chat cast memory — the mechanism that silently pointed chats at degraded auto-built slots — is removed. Every chat and branch reads the same sheet, always.
- Atmosphere caps loosened (setting 16 tags, state 200 chars) — correctness had been starving mood.

### 0.12.3 — two per frame is model physics
- The user's field observation was the truth: two-character panels were beautiful; three and four are where the pink kimono migrated. Single-prompt tag binding cannot reliably assign garments or wounds across 3+ people — the only hard binding mechanisms are per-character API conditioning (unavailable here) or **at most two subjects**. The cap is back to TWO, enforced in code at parse; a beat with three principals is split into consecutive panels (panels are unlimited; frames are not), everyone else is crowd. Raising the cap to four earlier was following a request against model physics — reverted with reasons on record.

### 0.12.2 — hybrid prompting: natural language where it earns its keep
- Why tags at all: anime-family models (NovelAI, Illustrious) are trained on Danbooru tag captions — tags are their native language, and tag runs are their only strong attribute-binding mechanism. Prose-native models (Gemini, GPT-image, FLUX) are a different species; the existing **Prompt style** setting already serves them (Auto/tags/natural).
- What sentences DO beat tags at on NAI 4.5: spatial relationships. Each panel now carries one builder-written plain-English **composition sentence** (relations and interaction only, zero appearance words), appended after the tags in tags mode. Identity and state stay code-welded tags; arrangement gets grammar.

### 0.12.1
- **State purity is enforced in code.** Builders were echoing each character's full appearance back into `state` (doubling identity per character) and long states were cut mid-word ("towering mus"), poisoning prompts with fragments. The weld now scrubs every state: tokens already in the owner's block are deleted, mid-word fragments (prefixes of block tokens) are deleted, and all caps are tag-safe — a disobedient builder becomes harmless. Negative-tested.

### 0.12.0 — state binds to its owner
- Identity binding worked; the last unbound layer was **state** — poses, wounds, expressions floated in a shared soup after the character blocks, so the model redistributed them (the dying man's laugh landed on his medic). Each `who` entry is now `{name, state}`: the extension welds each character's state onto their verbatim identity block — **one contiguous run per character** — and the panel prompt shrinks to what is genuinely shared: camera, lighting, atmosphere, environment, scene-wide effects.
- Setting and dress are tag-capped in code (12/8) — attention no longer dilutes across scenery bloat.
- Show last generation's WHO lines now include each character's bound state.

### 0.11.3
- **The cast author copies canon, never composes it.** Auto-build must take trait wording verbatim from story memory ('armband' can never become 'badge', 'medium' can never become 'short'), keep eye colors and exact hair lengths, list base clothing per character, and use 'man'/'woman' for adults — 'boy'/'girl' only for canonically child-statured characters.
- **The delete-per-chat ritual is dead.** Every chat now seeds its own NEW characters automatically, once, append-only — existing lines are never modified. To refresh one wrong entry: delete that single line; the next chat re-seeds it fresh.

### 0.11.2
- **Every generation self-identifies.** Show last generation now opens with `ENGINE vX.Y.Z` and `CAST — "name": N entries (first: ...)`, and the popup header carries the version. A pasted dump can never again be ambiguous about which engine ran or which cast sheet identity was copied from — the two questions that burned this session's last three rounds.
- Reminder the provenance line makes actionable: **each chat remembers its own active cast.** If the CAST line names an auto-built slot with paraphrased entries instead of your curated sheet, switch the cast dropdown for that chat — verbatim insertion is only as good as the sheet it copies.

### 0.11.1
- **The who schema is enforced, not requested.** If the builder returns panels without `who` while a cast sheet exists, SceneSnap rejects the output and issues exactly one corrective re-call; whichever output covers more panels wins, and the image is never blocked on compliance.
- **Compliance is visible**: Show last generation now prints a `PANEL n WHO — ...` line per panel. Verbatim cast blocks in the prompt = the new engine ran; a WHO line reading "(builder ignored the who schema)" after the retry = the builder profile itself is the problem — switch the Prompt builder LLM profile.
- **Native-language leaks scrubbed**: builders that drop CJK tokens into tag prompts ("trail of脚印") no longer reach the image model.

### 0.11.0 — identity is written by code
- **The builder no longer writes any named character's appearance — ever.** Each panel now carries a `who` list of exact cast names; the extension inserts every listed character's full tag block **verbatim from the cast sheet** and computes the count tags itself. Substitution (Lisa-for-Yumichika), omission (healing a missing patient), blending (three people fused into a child), and trait drift (skin tone changing between panels) are mechanically impossible for named characters — the builder physically cannot write their looks. Unknown names are reported, never invented. At 3+ characters the extension auto-appends placement tags in `who` order.
- **Contract**: the climax panel's victim must be in `who` (an explosion without the person it hits is a failed panel); healing/striking panels list BOTH parties; the panel prompt itself is actions/expressions/poses/effects/camera/scene only.
- **Crowds are setting-state**: the scene's standing population belongs in `setting` and is stamped on every panel; established spectators vanishing is now a named continuity violation.
- **NSFW skin-tone lock**: complexion joins sizes and marks as cast-sheet truth — identical in every panel and image.

### 0.10.2
- **Effects belong to their victim.** New contract: explosion/impact/glow/wound tags live inside the block of the character they happen TO — the exploding sword detonates in its holder's hands, never in the observer's block — and that character is the panel's primary. Characters not in contact must carry explicit spatial-relation tags, and with 3+ characters every block ends with a placement tag (left/center/right/foreground/background) so the model can keep people apart.
- **No substitutions, no hybrids, no children.** Only beat-named characters may appear, each copied verbatim from the cast; blending two people into one and rendering anyone as a child (unless their sheet says so) are contract violations. More than four foregrounded → fold extras into the crowd.
- **Malformed count tags fixed in code**: stacked alternatives ("2boys, 1boy, 1other") collapse to one expression per class, and non-danbooru forms ("1man") canonicalize — the field bug, negative-tested.
- **Rank garments can no longer ride the anchor from ANY source**: the builder's dress field is now rank-filtered in code, same as the mined backstop.

### 0.10.1
- **Explicit scenes are tagged explicitly.** New builder law: sexual/nude beats get concrete danbooru anatomy tags per character (undress state, exposed anatomy with size/texture descriptors, exact position by its danbooru name, contact state, fluids), with proportions locked to each character's cast tags across every image. Tip: fix sizes/marks in the cast sheet once and they stay identical everywhere. Vague NSFW was the worst-case of the general problem — body position accuracy — so precision here lifts every scene.
- **Strips are chronological and complete**: panels follow the scene's beats in strict order and the climax action (the strike, the explosion) MUST be one of them.
- **Panels are interconnected**: consequences carry forward — smoke lingers, wounds and debris persist, light never changes mid-scene; no panel may contradict an earlier one.
- **Acting on someone shows both parties**: the medic kneels beside a visible patient, never a cropped-out one.
- **Cast cap lifted to four** named characters per panel when the beat needs them (fewest preferred; full tag block per character, exact danbooru count tags).
- **Fixed: rank garments stamped on everyone.** The world-dress anchor was appending `captain haori, lieutenant armband` to every panel — including a no-insignia protagonist. The dress field is now contractually the universal base outfit only, and the cast-mining backstop filters rank-bearing garments. Negative-tested.
- Gate repair: an 0.10.0 trim overshoot had silently dropped four behavioral suites (anchor/mine/layout/stale) — restored, 73 checks green.

### 0.10.0 — multi-character mode removed
- **NAI multi-character mode is gone**, deliberately. Honest ledger: it was never observed working end-to-end anywhere — the build rig proved every link except the final NovelAI hop, and on the one real device it ran on, its transport died at browser level across clean browsers with every blocker theory eliminated. A feature that can't be verified and can't be used is a liability, and since 0.9.5/0.9.6 (seed-lock, two-character cap, solo close-ups, stamped world) the strips it was meant to help never touch it. Removed whole: transport, token setting, session latch, zip extractor, its prompts and its toasts. The last version carrying it is v0.9.6 (`git checkout v0.9.6-era` via history) if a desktop deployment ever wants to resurrect and actually verify it.
- The sheetless warning now fires on a sheet with no parseable entries, not just an empty one.

### 0.9.6 — the world stays itself, automatically
- **No manual dress-code line needed anymore.** The builder now derives this world's clothing style and this scene's setting ONCE, as data (`dress` + `setting` fields), and **the extension stamps both onto every panel prompt in code** — per-panel drift into modern uniforms or wrong architecture is structurally impossible instead of a memory test for the builder. Duplicate tags are deduped on stamping.
- **Cast-sheet mining backstop**: if the builder returns no dress field, the cast sheet is treated as the world's wardrobe — garment-bearing tags are mined from it (generic garment lexicon, world-agnostic) and stamped instead.
- **Public addresses look public**: a line spoken to a group is drawn as the speaker with the addressed group visible and attending — never a private two-shot.
- The anti-modernize guard is explicit: no modern dress or architecture unless cast tags or scene text literally describe them.

### 0.9.5
- **Panel discipline contract** (fixes outfit drift, character blending, wrong poses, and speakers ignoring their audience): max two named characters per panel with full cast tags each and explicit count tags first; clothing may come only from cast tags and scene wording — never from role words ("officer" is a job, not an outfit); crowds get one collective emotion and world-accurate dress; a panel's speaker faces their audience; actions are single concrete danbooru tags ("clapping"), never compound phrases image models misread.
- Tip: for strict world dress codes, add one line to **Extra builder rules** naming what people canonically wear — the contract will then quote it into every crowd and character.

### 0.9.4
- **Strips render full-width inline.** SceneSnap images now fill the whole message column instead of SillyTavern's 40vh thumbnail — the comic reads in the chat, no tap-to-fullscreen. Survives reloads (SceneSnap media is flagged and re-marked on chat render).
- **No more comics-inside-panels.** Builders that leak page-layout language ("comic strip, 4 panels, panel 1:") into a panel prompt made the image model draw a nested grid inside the panel. Panel prompts are single frames by contract now: the rule is in the builder prompt AND a deterministic scrub removes layout words from every prompt. Negative-tested.
- **Multi-char stops burning attempts.** If the browser blocks its transport once, SceneSnap skips it for the rest of the session — no repeated toast, no wasted first call, strips unaffected. The settings hint says so.

### 0.9.2
- **Same person in every panel.** The whole strip now shares one generation seed: identical seed + identical appearance tags = the same rendition of each character across panels, instead of a fresh re-roll per panel. Works on NovelAI, Runware, and Pollinations.
- **Rigid printed-comic grid.** Every panel cover-fills an identical cell — thin gutters, black panel frames, no letterboxing, and no stray panel size can break the layout.
- The sequence prompt now carries an explicit outfit contract: full appearance tags repeated verbatim per panel, no outfit/hair/color changes between panels.

### 0.9.1
- **Strips render large.** Panels in sequence mode now generate in landscape and stack into a readable manhwa-strip shape (~1:2), instead of three portrait towers squeezed to a sliver by the chat viewer's height limit. Single-frame generations keep your chosen size preset untouched.
- **Dialogue spreads across panels** — one bubble per panel by default, in speaking order; two only for a tight same-beat exchange. No more both lines crammed onto one face.

### 0.9.0 — the Reddit-strip release
- **The strip is guaranteed.** With Max panels ≥ 2, the builder must produce at least 2 panels — "one moment carries the scene" can no longer collapse your comic into a single frame.
- **Bubbles never chop a sentence.** Lines up to 110 chars ship whole; longer lines cut exactly at a sentence boundary, and only sentence-less run-ons get a word-safe cut with a visible ellipsis. The mid-phrase amputation ("…a Thirteenth Division") is dead.
- **Bubbles stay off faces.** Two bubbles now sit side-by-side in the top band of the panel (left/right), never stacked down the frame onto heads.
- When multi-char is skipped by a network-level death but the standard route succeeds seconds later, **Show last generation now states the proven conclusion**: the request is being blocked inside the browser, not by the server.

### 0.8.5
- **The button always ships an image.** Multi-character mode is now best-effort: if its request fails for any reason at all, SceneSnap generates the same scene through the standard route (the exact path "Test backend" exercises) instead of erroring out with nothing. The obstruction is named once in a yellow toast ("Multi-char skipped: ...") and recorded verbatim in **Show last generation** under "Multi-char skipped".
- Mid-transfer body deaths get the same evidence-based classification as dead fetches (server probed, verdict stated).

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

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
3. **Prompt-format mismatch** — anime checkpoints (Illustrious / NoobAI / NovelAI) want **Danbooru tags**; FLUX-style models want **natural language**. Feeding one the other's format produces mush. SceneSnap auto-matches prompt style to the backend.

## Pipeline

```
AI message rendered
   └─ scene text (top header kept + final ~70% kept)
      + active cast sheet
      + your extra rules
   └─ Prompt builder LLM (Connection Manager profile, or main API)
      → tags / natural prompt for one frozen frame
   └─ Image backend → saved to chat files → attached to end of the message
```

Generation runs after the message renders. It never delays text generation. The paintbrush icon on the message shows an hourglass while working; multiple images per message become a swipeable gallery.

## Backends

| Backend | Prompt style | Setup | Notes |
|---|---|---|---|
| **Runware** (recommended) | Danbooru tags | API key + model AIR | Runs any Civitai checkpoint (Illustrious/NoobAI family) at sub-cent cost, typically 1–3 s per image. Get the AIR from the model page sidebar on Civitai, e.g. `civitai:XXXXXX@XXXXXXX`. |
| **NovelAI** | Danbooru tags | NovelAI key set in ST's API Connections | V4.5 Full is the strongest anime model available; Opus sub = effectively unlimited standard-size gens. Steps capped at 28 to stay in the free-generation band. |
| **Pollinations** | Natural language | None | Free, zero-config. Use it to test the pipeline before paying for anything. Quality/consistency below the other two. |

Good starting checkpoints for Runware: any high-rated **Illustrious XL** or **NoobAI-XL** merge on Civitai. Community-recommended params are already the defaults (steps ~26, CFG 5, clip skip 2). Leave scheduler blank unless you know the model prefers `Euler a`.

## Cast sheets

One line per character:

```
Jovan: boy, short black hair, red eyes, tall, lean build, academy uniform
Stella: girl, long crimson hair, red eyes, large breasts, hair ribbon, school uniform
```

- **Auto-build cast from chat** scans the last ~24 messages (including tracker blocks) with the builder LLM and appends new characters. Always review the result.
- Casts are global; each chat remembers which cast is active — so one cast per story world, shared across all its chats.
- Only characters *visible in the final frame* get pulled into a prompt.

## Settings that matter

- **Prompt builder LLM**: pick a *fast* Connection Manager profile. The builder call is ~500 tokens out; a fast model keeps image latency low. Falls back to your main API if unset.
- **Strip from scene**: regexes (one per line) removed from the message before prompt building. Defaults already cover `<details>` blocks, `{ALLCAPS}...{/ALLCAPS}` tracker blocks, and HTML comments — so stat trackers at the end of a message never displace the final prose beat.
- **Extra builder rules**: story-agnostic constraints, e.g. `Never depict more than 2 characters` or `Interior scenes: always include window lighting`.
- **Always-append quality tags / Negative prompt**: standard Illustrious/NoobAI quality block is prefilled.
- **/snap** — illustrate the last AI message. **/snap 42** — illustrate message #42. Paintbrush icon on any AI message does the same.
- **Reset defaults** restores the tuned baseline (steps/CFG, sizes, prompt style, quality/negative blocks) while keeping your API key, Runware model, cast sheets, extra rules, builder profile, and backend choice.

## Troubleshooting

- **"Prompt builder returned an empty response"** — the profile model may be reasoning-only or unreachable; pick another profile or leave on Main API.
- **Runware "invalid model"** — re-copy the AIR from Civitai; version IDs change when models update.
- **NovelAI 401** — set your NovelAI key under API Connections (NovelAI) first.
- **Auto mode fired on an old message** — it only targets the newest AI message and suppresses itself for a moment after chat switches; if you see otherwise, report the console log.

## License

MIT

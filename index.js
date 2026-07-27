// SceneSnap — scene illustrations for immersive RP, attached to the end of AI messages.
// Pipeline: scene text + character cast sheet -> LLM prompt builder -> image backend -> media attached to message.
import {
    appendMediaToMessage,
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getBase64Async, saveBase64AsFile } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const MODULE = 'sceneSnap';
const VERSION = '0.44.0';

const defaultSettings = Object.freeze({
    enabled: true,
    auto: true,
    autoCast: true,
    backend: 'pollinations', // pollinations | runware | novelai | nanogpt
    promptStyle: 'auto',     // auto | tags | natural
    sizePreset: 'portrait',
    activeCast: 'Default',  // portrait | landscape | square
    builderProfile: '',      // Connection Manager profile id ('' = main API)
    maxSceneChars: 6000,
    maxPanels: 1,
    dialogueBubbles: true,
    stripPatterns: '<details>[\\s\\S]*?</details>\n\\{[A-Z_]+\\}[\\s\\S]*?\\{/[A-Z_]+\\}\n<!--[\\s\\S]*?-->',
    forcedTags: 'masterpiece, best quality, absurdres, detailed background',
    negativePrompt: 'lowres, worst quality, bad quality, bad anatomy, bad hands, extra digits, jpeg artifacts, signature, username, logo, watermark, artist name',
    extraRules: '',
    casts: { 'Default': '' },
    // Runware
    runwareKey: '',
    runwareModel: '',
    runwareSteps: 26,
    runwareCfg: 5,
    runwareScheduler: '',
    // NovelAI
    naiModel: 'nai-diffusion-4-5-full',
    naiSteps: 28,
    naiScale: 5,
    // Pollinations
    pollModel: 'flux',
    // NanoGPT (OpenAI-compatible image API: Qwen-Image, Flux, 200+ models)
    nanogptKey: '',
    nanogptModel: 'qwen-image',
    nanogptSteps: 30,
    nanogptCfg: 7.5,
});

const SIZE_PRESETS = {
    portrait: { width: 832, height: 1216 },
    landscape: { width: 1216, height: 832 },
    wide: { width: 1344, height: 768 },
    square: { width: 1024, height: 1024 },
};

// Applied automatically while the user hasn't customized the matching field.
// Quality-word blocks are OUT for NovelAI (0.28.0, user A/B): 'very aesthetic /
// best quality / amazing quality' made outputs visibly worse — the prompt starts
// with the subject, and only the functional tail rides at the end.
const BACKEND_QUALITY = {
    novelai: 'no text, detailed background',
    pollinations: 'highly detailed, cinematic lighting, rich detailed background',
    nanogpt: 'highly detailed, cinematic lighting, rich detailed background',
};
const BACKEND_NEGATIVE = {
    novelai: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, watermark, film grain, scan artifacts',
};
// The docs' strengthening/weakening syntax survives ST's route untouched (it travels
// inside v4_prompt.caption.base_caption, parsed server-side): the functional tail
// above carries V4.5 negative emphasis — the docs' own rescue for flat, washed
// output ("-2.5::flat color :: can fancy it right up"); 1.5 is the moderate dose.

let lastDebug = null;

const TAG_SYSTEM_PROMPT = `You are an image prompt engineer for a Danbooru-tag anime model (Illustrious / NoobAI / NovelAI family). Convert the final moment of a roleplay scene into ONE image prompt.

OUTPUT: a single line of comma-separated Danbooru tags. No sentences, no quotes, no markdown, no explanations.

BUILD ORDER:
1. FRAME — identify the FINAL visual beat: the last thing a camera would see. One frozen instant, never a montage.
2. COUNT — who is physically visible and central: 1boy, 2boys, 1boy 1girl, etc. Background crowds do not change the count tags.
3. CHARACTERS — copy each visible character's appearance tags from CHARACTER SHEETS verbatim. The sheets are the ONLY source for hair, eyes, build, and default clothing. NEVER invent clothing, accessories, jewelry, or states of undress that neither the sheets nor the scene state.
4. WARDROBE — if the message has a header/tracker stating current time, location, or worn clothing, it overrides sheet defaults.
5. ACTION — expression, pose, and physical interaction tags (collar grab, knee strike, clenched teeth, punch...), plus impact/motion tags when fitting: motion blur, speed lines, foreshortening, dust cloud, flying debris.
6. CAMERA — one dramatic framing tag: close-up / upper body / cowboy shot / full body / wide shot / from below / from behind / from side / dutch angle.
7. WORLD — 5-10 environment tags, mandatory whenever the scene has a real location: place, architecture, background detail, crowd or audience if present (crowd, audience, stadium, cheering crowd), weather, time of day, lighting (dramatic lighting, backlighting, sunlight, lens flare, dappled light).

RULES:
- 25 to 45 tags total. A rich WORLD section is required, not optional.
- No character names as tags; use sheet appearance tags instead.
- Never tag characters who are only mentioned, remembered, or off-screen — a crowd is scenery, not characters.
- Keep every character's age and relative size consistent with their sheet; never render anyone as a child unless the sheet explicitly says so.
- No story text, dialogue, or quotation marks.`;

const NATURAL_SYSTEM_PROMPT = `You write image prompts for a natural-language image model (FLUX family). Convert the final moment of a roleplay scene into ONE image prompt.

OUTPUT: 4-7 plain sentences describing a single frozen instant, starting with "Anime illustration." No markdown, no quotes, no explanations.

REQUIREMENTS:
1. Depict the FINAL visual beat — the last thing a camera would see. One instant, never a montage.
2. Describe only the characters physically visible in that instant, using their exact appearance details from CHARACTER SHEETS. The sheets are the ONLY source for hair, eyes, build, and default clothing — NEVER invent clothing, accessories, jewelry, or states of undress that neither the sheets nor the scene state.
3. If the message has a header/tracker stating current time, location, or worn clothing, it overrides sheet defaults.
4. Dedicate at least one full sentence to the environment: location, background detail, and any crowd or audience, with atmosphere (dust, weather, time of day).
5. Name a dramatic camera angle (low angle, wide shot, close-up, over-the-shoulder...) and the lighting.
6. Keep every character's age and relative size consistent with their sheet; never render anyone as a child unless the sheet explicitly says so.

RULES: no character names, no dialogue, no story text.`;

const CAST_SYSTEM_PROMPT = `You extract character appearance sheets for an anime image model from a roleplay story.
STORY MEMORY (established canon, summary snippets, author's note) is your PRIMARY source for appearances — it accumulates the whole story. Use the recent chat excerpt only for characters memory has not captured yet.
Output one line per NEW named character, in exactly this format and nothing else:
Name: girl|boy|woman|man, hair length + hair color, eye color, 2-5 distinctive physical tags, default outfit tags
Example:
Akane: girl, long black hair, ponytail, brown eyes, athletic build, school uniform, red ribbon
Rules: visual traits only — never personality, locations, positions, or current actions. Max 12 tags per character, Danbooru-style tags, prefer information from character tracker blocks when present, skip characters already listed in EXISTING SHEET.
NO CHARACTER NAMES IN THE TAGS, EVER — not the character's, not the work's. A name tag makes the image model draw its own idea of that character, which then fights the body you described, and the two blend into something that is neither. Describe the BODY: sex, build, hair colour and length, eye colour, distinguishing marks, then clothing. "man, tall, lean, long red hair in a high ponytail, brown eyes, black tribal tattoos over brows and shoulders, white headband" — never "abarai renji", never "bleach".
APPEARANCE SOURCE ORDER: 1) CANON WIKI DATA when present — it is authoritative; convert its prose faithfully into danbooru tags. 2) Story memory and chat text. 3) For an ESTABLISHED CANON CHARACTER of the story's fandom that neither source describes, use their widely known canonical appearance in standard danbooru tags — canon characters are never "unknown". Reserve "Name: gender, (appearance unknown — fill in)" strictly for ORIGINAL characters no source describes.
RANK IS NOT AN OUTFIT, in the cast line either: write the garment you can SEE ('white armband on left arm'), never the rank that garment signifies ('lieutenant's badge', 'captain's insignia', 'officer's braid') — an image model reads a rank word as modern military dress and returns gold cuff braid and shoulder boards.
COPY, never compose: take each trait's wording from the story/memory VERBATIM where it appears — never synonymize or re-style ('lieutenant armband' stays 'armband', never 'badge'; 'medium white hair' never becomes 'short white hair'). Adults are 'man'/'woman'; 'boy'/'girl' ONLY for characters the story marks as children or child-statured. Always include eye color and exact hair length when the story states them; never drop a distinguishing trait the memory contains; base clothing (uniform/kimono) is listed per character, not assumed. ALWAYS include the story's protagonist/viewpoint character — the player's character counts as a character. If a required character's appearance is never described, still output their line as: Name: gender, (appearance unknown — fill in). If there are no new characters at all, output NONE.`;

// One canonical dialogue-bubble contract, cited by both builder paths — never restated.
const BUBBLE_RULES = `DIALOGUE BUBBLES (active):
Alongside each panel prompt, pick 0-2 spoken lines for that panel's beat, copied VERBATIM from the SCENE text — never invent, paraphrase, translate, or merge lines. Use TWO lines whenever the beat has two voices (a cry and an answer, an order and a moan) — never leave a talkative beat with an empty bubbles field. In explicit scenes, moans, cries, and spilled names ARE dialogue: prefer the scene's rawest verbatim lines. Spread dialogue across panels in speaking order and never repeat a line across panels. Max 12 words per line; prefer the punchiest dialogue of the beat. "speaker" is the exact character name. If the beat has no spoken dialogue, use an empty array. The image prompt itself must still contain no dialogue or quotation marks — spoken lines go ONLY in the bubbles field; SceneSnap draws them onto the image afterward.`;

// Explicit scenes get explicit tags: vagueness is the accuracy killer in NSFW beats.
// The panel-focus law is the user's own: solo for body moments, duo for dialogue,
// BOTH with visible named genitals for sex. Euphemism is a failed panel.
const NSFW_RULE = `

EXPLICIT SCENES: when the scene is sexual or nude, tag it exactly — never euphemize or fade to black.
PANEL FOCUS LAW: a solo body moment (undressing, bathing, posing, touching herself) is ONE person in "who". A dialogue or an exchange is BOTH. A sex act is ALWAYS BOTH — and the act is named by its danbooru term in the shared prompt (vaginal sex, missionary, cowgirl position, doggystyle, standing sex) with the penetration state, while EACH character's state carries their visible anatomy: breast class + nipples, penis/erection/testicles, pussy/vulva, anus when visible, fluids. EUPHEMISMS ARE FAILED PANELS: 'drives deep', 'buried inside', 'joins with her', 'connected' are forbidden — if the act cannot be named in danbooru terms, it cannot be drawn.
NUDITY: when the scene has a character naked, that character's state says 'completely nude' — 'uniform pushed open' or 'pulled aside' ONLY when the scene text says the clothes stay on. Otherwise state the garments removed/open, the exposed anatomy, and body proportions CONSISTENT with that character's cast tags in every panel. Anatomy follows the cast sheet: sizes, marks, and SKIN TONE come from cast tags and stay identical in every panel and every image — a character may never change complexion between panels. In natural-language mode, express the same specifics as prose.
CONTACT POSTURES: during the act, name the position and keep both bodies. AFTERGLOW and cuddle panels (post-climax, resting, talking) show the partners SIDE BY SIDE or one propped beside the other — never stacked 'still joined above her' contact with both lying, which fuses two bodies into one mass and flips who is on top (field-proven).`;

// NovelAI V4.5 prompt craft from the official docs (strengthening-weakening): the
// builder shapes the LANGUAGE of each panel; code assembles the structure. The user
// asked for this explicitly — guidance in the builder's hands, not code's format.
const NAI_GUIDANCE = `NOVELAI V4.5 PROMPT CRAFT (official guidance — apply it yourself):
- ORDER IS STRENGTH: the model reads left to right. What matters most goes first — identity traits and the panel's main action early, atmosphere last.
- EMPHASIS: wrap 1-3 CRITICAL tags per panel in {braces} to strengthen them ({sky-blue blade}, {violet eyes}); [brackets] weaken something that keeps stealing focus. Emphasis on everything is emphasis on nothing — never more than 3 braced tags per panel. For the ONE thing the panel lives or dies by, numerical emphasis is allowed (1.2::tag::).
- HYBRID: V4.5 reads short natural phrases as tags — 'rain-light through shoji' or 'crowd laughing and retreating toward the doors' bind better than fragment piles.
- CONCRETENESS: every tag must be something a camera can see. No moods, no metaphors.`;

// One canonical grounding-authority rule, cited by both builder paths — never restated.
const GROUNDING_RULE = `

GROUND TRUTH: when a CURRENT WORLD STATE block is provided, it is authoritative — its ON SCREEN list defines who may be depicted (OFF SCREEN characters are forbidden even if the prose mentions them), and its per-character lines give current location, condition, activity, and clothing, overriding sheet defaults and any assumption. PRECEDING CONTEXT is reference only, for resolving pronouns, place, time, and outfits — the illustration always depicts the SCENE's final beat, never events from the preceding context.`;

// One canonical per-frame law block, cited by BOTH builder modes (sequence and
// structured single frame) — never restated. Identity/state welding, the two-cap,
// shot grammar, acting density, the composition sentence, and the WORLD data contract
// live here once.
const FRAME_LAWS = `PANEL DISCIPLINE (binding rules for every panel):
- When someone acts ON another person (healing, striking, carrying, restraining), the panel shows BOTH — the object of the action is never cropped out. A medic kneels beside a VISIBLE patient.
- WHO writes identity AND owns state, and WHO is not you: list each panel's characters in "who" as {"name": exact cast-sheet name, "state": THAT character's pose, expression, wounds, and action tags — pose and feeling ONLY. Never a count tag (1boy, 1girl, 2boys, solo) and never a garment: the extension computes every count itself and dresses every character itself, and a count tag inside a character's block reads to the image model as a second person starting there, which fuses the frame's two characters into one} — primary first, AT MOST TWO. Two is model physics, not preference: single-prompt tag binding cannot reliably assign a garment or a wound across three people, so a frame never holds more than two principals — everyone else is crowd. The extension enforces the cap.
- WHO IS THE PEOPLE THE BEAT'S ACTION PASSES BETWEEN, and nobody else. If the beat is an action between two people — speaking to, striking, healing, carrying, standing at someone's shoulder, reacting to each other — BOTH are in "who"; cropping the other one out is a failed panel. If the beat happens inside one person — a private realization, a salute to a memory, a face in the ranks — that is one name. If the beat belongs to the crowd itself (the courtyard erupting, three hundred voices at once), pick ONE principal as the foreground witness and show the crowd behind them — pure crowd frames render empty or insane (field-proven, repeatedly); "who": [] is reserved for scenes with NO named characters present, and must still be PRESENT, because an omitted "who" is non-compliance and gets the panel rejected. Never more than two: single-prompt tag binding cannot assign a garment or a wound across three people, so a third principal means the beat SPLITS across two panels and everyone else is crowd. Never pad a frame to two, and never cut a frame to one.
- A panel that carries a dialogue bubble must SHOW ITS SPEAKER'S FACE: dialogue never rides a from-behind, neck-down, or faceless framing of its own speaker. Only a character in THIS panel's "who" may speak in this panel — a line belonging to anyone else moves to the panel that draws them, or is dropped. The extension enforces this. The extension inserts each character's appearance block VERBATIM from the cast sheet, welds their state onto it, and computes the counts — one contiguous run per character, so the image model cannot give one character's laugh or wound to another. The panel "prompt" therefore contains ONLY what is shared: camera, lighting, atmosphere, environment, and scene-wide effects. A per-character detail in the shared prompt, or any appearance trait anywhere, is a failed panel.
- The character an effect happens TO carries it in their OWN "state": the exploding sword detonates in its holder's state, the wound bleeds in the wounded one's state — a climax panel whose victim is missing from "who" is a failed panel. Healing, striking, carrying, restraining: BOTH parties in "who", each with their own state; "hand on patient" with no patient listed is a failed panel.
- Characters not in physical contact get explicit spatial-relation tags in the prompt (distance between them, one far in the background, facing from across the field).
- A character drawn far away, tiny, or as a silhouette is NOT in "who" — name them in the prompt as an environment element ("a distant figure across the courtyard"). A background figure in "who" spends a subject slot and a count tag on someone three pixels tall. The extension demotes them.
- SHOT GRAMMAR (every panel's "prompt", mandatory): exactly ONE framing tag (close-up / upper body / cowboy shot / full body / wide shot) + exactly ONE angle tag (from below / from behind / from side / eye level / dutch angle) + lighting and atmosphere tags (dramatic lighting, sunlight, lens flare, backlighting, wind, dust motes, motion blur where there is motion). A frame whose crowd must be SEEN needs a crowd-visible camera — cowboy shot / wide shot / eye level / from above. NEVER from below or close-up when the crowd matters: a camera pointed at the sky or into a face crops the audience out of the frame, and the panel renders an empty venue with 'crowd' sitting in the tags (field-proven).
- ACTING DENSITY: each character's "state" is 4-8 concrete tags — pose AND expression AND gaze AND one physical emotive detail (tears streaming, clenched fist at chest, open mouth shouting, trembling hands). A two-tag state is a failed panel.
- "sentence" is where natural language earns its keep: ONE short plain-English sentence per panel stating the spatial arrangement and interaction ("She kneels beside him at the crater's center, pressing both hands to his chest while the crowd watches from the stands."). Relations only — any appearance word there is a failed panel.
- Never blend two people into one, and never render anyone as a child unless their cast tags say so.
- Clothing comes ONLY from cast tags and explicit scene wording. NEVER derive clothing or armor from rank/role words: 'officer', 'captain', 'soldier', 'guard', 'division' are jobs, not outfits — writing 'military uniform' because the scene says 'officers' is a failed panel.
- A background crowd is scenery: give it ONE collective emotion and describe its dress by copying the scene's world (what these people canonically wear), never by role words.
- The panel's speaker (if it has a bubble) is drawn mid-speech, body and face oriented toward whoever they address — a speaker addressing a crowd faces the crowd, not the camera.
- Actions are single concrete danbooru tags (clapping, arms crossed, pointing, hand on own chest) — never compound phrases like 'hands clapping together', which image models misread.
- A line spoken to a group is drawn as the speaker prominent with the addressed group visible and attending — never a private two-shot for a public address.
WORLD (derive once, as data): from the SCENE text and CAST tags, infer this world's shared clothing style and this scene's physical setting. "dress" is ONLY the universal base outfit every ordinary person wears — never rank- or status-specific garments (captain's coats/haori, armbands, crowns, insignia): those belong exclusively to the cast tags of whoever holds the rank. Never modernize: no modern uniforms, coats, neckties, or architecture unless cast tags or scene text explicitly describe them. "setting" also names the scene's standing population AND that population's dress ("packed stands of shinigami in black shihakushō", "crowd of villagers in gray work clothes") — an unnamed crowd dress is how background people modernize: an arena full of watchers shows watchers in every panel that shows the surroundings, and established spectators never vanish (that is a continuity violation). "setting" is a STANDING description stamped unchanged onto EVERY panel: it names the place and its population and what that population wears — never what the population is momentarily doing. A transient verb there ("dispersing crowd", "crowd leaving") contradicts every panel of the scene and is a failed strip; the crowd's current action belongs in each panel's own prompt. Output both as flat tag lists in the top-level "dress" and "setting" fields — the extension stamps them onto every panel itself, so do NOT restate them inside panel prompts.`;

// ---------------------------------------------------------------- the plan pass
//
// One call was choosing the beats, ordering them, assigning who was in each frame,
// deriving the world, writing every tag, and obeying seven thousand characters of law.
// Every field failure of the last six versions was a PLANNING failure — a beat spent
// twice, two people packed into one frame, an all-solo strip, a population nobody
// named — and code could not catch any of them, because the plan arrived already fused
// to its own rendering. So the strip is planned first, in plain language, small enough
// to check: the panel list is validated (and repaired) BEFORE a single tag is written.
const PLAN_LAWS = `PLAN FIRST, IN THE SAME ANSWER. Before you write a single tag, lay the strip out as a list of beats — this is the "plan" array of your JSON, and the "panels" array renders it one for one, in the same order.

PANELS: pick how many the scene's climax needs (2 to %MAX%). One DISTINCT beat each, in the order they happen, ending on the final beat, and the climax action itself MUST be one of them. SPEND THE BUDGET: a climax with a shout, a crowd's eruption, and two or more reactions has 4+ beats — use up to %MAX% panels and give the major named reactors their own frames; a short strip is for a scene with few beats, never a full one with beats dropped.
- THE BEATS ARE A CHAIN, NOT A LIST. Beat 2 is what happens NEXT because of beat 1; beat 3 follows beat 2. Every panel after the first states in "follows" what makes it the next moment — "the blade is now overhead, and the courtyard answers it", "his shout has landed and the old man responds to it". A panel whose "follows" could be deleted without anyone noticing is an independent picture, not a strip.
- STRICT CHRONOLOGY: the strip runs forward in time. Never open on the crowd's reaction and then cut back to the action that caused it.
- Every panel a different beat. One action stretched over two panels (a sword leaving its sheath, then that same sword held overhead) is ONE beat; pick the stronger image and spend the freed panel elsewhere.
- More beats than panels: drop the weakest. Never merge two beats into one frame.

WHO is the people the beat's action passes BETWEEN, and nobody else:
- An action between two people (speaking to, striking, healing, standing at someone's shoulder, reacting to each other) lists BOTH — cropping the other one out is a failed panel.
- A beat that happens inside ONE person (a private realization, a salute to a memory) lists that one name.
- A beat belonging to the crowd (the courtyard erupting, three hundred voices at once) is drawn THROUGH one foreground witness: pick the principal whose reaction best carries the beat and show the crowd behind them — field-proven: pure crowd frames render empty halls and scale insanity, crowds behind a principal render every time. "who": [] is reserved for scenes where NO named character is present.
- Never more than two names: a single image prompt cannot bind a garment or a wound across three people. A third principal means the beat splits across two panels.
- Never pad a frame to two, and never cut a frame to one. Use EXACT cast-sheet names.
- A panel with TWO names must fill "between" with what passes between them — who is looking at, speaking to, touching, or answering whom. Two people who merely happen to be in the same courtyard doing separate things are not a two-shot; that is two panels, or one.
- Never give the same lone character two panels in a row. One continuous action (the blade leaving the sheath, then the blade held overhead) is ONE panel — spend the other on a beat or a character the strip is otherwise dropping.

WORLD, derived once: "setting" is the standing description of the place stamped on every panel — location, architecture, weather, light, AND the scene's population with what that population wears ("packed stands of shinigami in black shihakusho"). Never what the population is momentarily doing. "dress" is ONLY the universal base outfit an ordinary person of this world wears — never rank- or status-specific garments.

THE BEATS ARE IN THE SCENE, not in a template. Read the scene's own action sequence: every distinct physical beat the TEXT contains is a panel candidate, in scene order, up to %MAX%. A scene that opens mid-act opens mid-act — never import beats the scene does not have (undress when they are already naked), never compress a scene with six beats into two panels. The climax action itself MUST be one of them.

The plan entry for each panel is: {"beat":"<one plain sentence: what this frame shows>","follows":"<how this moment follows the previous panel — omit on panel 1>","between":"<what passes between the two people — required when "who" has two names>","who":["Exact Cast Name"]}`;

// Same default presence-marker patterns as Summaryception's ledger: a preset's
// [IST: name|state] in-scene tracker and [ACW: name|...] off-screen watchlist.
const DEFAULT_PRESENCE_ON = '\\[IST:\\s*([^|\\]]+)';
const DEFAULT_PRESENCE_OFF = '\\[ACW:\\s*([^|\\]]+)';

let settings = {};
const inFlight = new Set();
const autoDone = new Set();
let suppressAutoUntil = Date.now() + 3000;

// ------------------------------------------------------------------ utils

function uuid() {
    try { return crypto.randomUUID(); } catch { /* non-secure context fallback */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function getSize(landscape) {
    const p = SIZE_PRESETS[settings.sizePreset] || SIZE_PRESETS.portrait;
    // Strip mode: stacked portrait panels make a 1:3+ tower that chat viewers shrink to a
    // sliver. Wide frames stacked stay large and readable — the manhwa-strip shape.
    if (landscape && p.height > p.width) return { width: p.height, height: p.width };
    return p;
}

function resolveStyle() {
    if (settings.promptStyle === 'tags' || settings.promptStyle === 'natural') return settings.promptStyle;
    // Qwen-Image/Flux-class models read paragraphs, not danbooru.
    return ['pollinations', 'nanogpt'].includes(settings.backend) ? 'natural' : 'tags';
}

// Since 0.8.1 every fetch in this extension is same-origin (the gate asserts no
// cross-origin fetch exists), so a browser-level fetch failure has exactly one
// meaning: the SillyTavern server itself didn't answer (restarting, or down).
// Covers Chrome ("Failed to fetch"), Firefox ("NetworkError..."), Safari ("Load failed").
function explainError(message) {
    const m = String(message || '');
    if (/failed to fetch|networkerror|load failed/i.test(m)) {
        return "SillyTavern's server didn't answer — it's likely restarting or down. Wait for it to finish starting, reload this page, then try again.";
    }
    return m;
}

function notifyError(err) {
    console.error('[SceneSnap]', err);
    try { toastr.error(explainError(err?.message || err).slice(0, 300), 'SceneSnap', { timeOut: 10000 }); } catch { /* noop */ }
}

async function urlToBase64(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download generated image (${res.status})`);
    const blob = await res.blob();
    const dataUrl = await getBase64Async(blob);
    return String(dataUrl).split(',')[1];
}

function findLastAiMessageId() {
    const ctx = getContext();
    for (let i = (ctx.chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return null;
}

// ------------------------------------------------------------------ casts

// Casts are global; the SELECTION is per-chat (0.42.0, user requirement): each chat
// remembers which cast it uses, restored on chat switch — no more re-picking per
// chat, no more Story B rendered with Story A's faces. The sheet data stays global,
// so two chats CAN share a world deliberately by picking the same cast.
function getActiveCastName() {
    try {
        const n = getContext().chatMetadata?.scenesnap_cast;
        if (n && Object.prototype.hasOwnProperty.call(settings.casts, n)) return n;
    } catch { /* noop */ }
    const name = settings.activeCast;
    if (name && Object.prototype.hasOwnProperty.call(settings.casts, name)) return name;
    return 'Default';
}

function setActiveCastName(name) {
    settings.activeCast = name;
    try {
        const md = getContext().chatMetadata;
        if (md) md.scenesnap_cast = name;
    } catch { /* noop */ }
    saveSettingsDebounced();
}

function getActiveCastSheet() {
    return String(settings.casts[getActiveCastName()] || '').trim();
}

// ------------------------------------------------------------------ LLM prompt builder

async function callLLM(system, user, maxTokens = 500) {
    const ctx = getContext();
    const profileId = settings.builderProfile;

    if (profileId && ctx.ConnectionManagerRequestService) {
        const profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
        if (profiles.some(p => p.id === profileId)) {
            try {
                const res = await ctx.ConnectionManagerRequestService.sendRequest(
                    profileId,
                    [{ role: 'system', content: system }, { role: 'user', content: user }],
                    maxTokens,
                );
                const content = typeof res === 'string' ? res : res?.content;
                if (!content || !String(content).trim()) throw new Error('Prompt builder (profile) returned an empty response');
                return String(content);
            } catch (err) {
                console.warn('[SceneSnap] builder profile failed, falling back to Main API:', err);
                try { toastr.warning(`Builder profile failed (${String(err?.message || err).slice(0, 120)}) — using Main API this time`, 'SceneSnap', { timeOut: 8000 }); } catch { /* noop */ }
            }
        }
    }

    // Preset-free fallback: generateRaw sends ONLY these two strings through the
    // current connection — no chat history, no active preset. A quiet prompt runs
    // through the full generation pipeline, so a heavy RP preset (laws, CoT)
    // contaminates the builder's output; it stays as the last-resort transport only.
    if (typeof ctx.generateRaw === 'function') {
        try {
            const rawReply = await ctx.generateRaw({ prompt: user, systemPrompt: system });
            if (rawReply && String(rawReply).trim()) return String(rawReply);
            console.warn('[SceneSnap] generateRaw returned empty, falling back to quiet prompt');
        } catch (err) {
            console.warn('[SceneSnap] generateRaw failed, falling back to quiet prompt:', err);
        }
    }
    const reply = await ctx.generateQuietPrompt({ quietPrompt: `${system}\n\n${user}` });
    if (!reply || !String(reply).trim()) throw new Error('Prompt builder returned an empty response');
    return String(reply);
}

function sanitizeBuilderOutput(text, style) {
    let t = String(text)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```[a-z]*\n?|```/gi, '')
        .trim();

    const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
    if (style === 'tags') {
        if (lines.length > 1) {
            // Pick the most tag-dense line in case the model narrated around the answer.
            lines.sort((a, b) => (b.split(',').length - a.split(',').length) || (b.length - a.length));
            t = lines[0];
        }
        t = t.replace(/^\s*(tags?|prompt|output)\s*:\s*/i, '').replace(/\.\s*$/, '');
        // Some builders leak native-language tokens into tag prompts ('trail of脚印' — field
        // bug); image models read English danbooru tags, so CJK runs are stripped in tags mode.
        t = t.replace(/[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g, '').replace(/\s{2,}/g, ' ').replace(/\s*,(\s*,)+/g, ',');
    } else {
        t = lines.join(' ').replace(/^\s*(prompt|output)\s*:\s*/i, '');
    }

    t = stripLayoutMeta(t.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim());
    if (!t) throw new Error('Prompt builder output was empty after cleanup');
    return t.slice(0, 1500);
}

// Builders sometimes leak layout meta-language ("comic strip, 4 panels, panel 1: ...")
// into a panel prompt, which makes the image model draw a comic page INSIDE the panel —
// nested grids. Panels are single frames by contract; scrub layout words deterministically.
function stripLayoutMeta(text) {
    const layoutMetaRe = /\b(comic(?:\s+(?:strip|page))?|manga\s+page|\d+\s*panels?|panel\s*\d+\s*:?|(?:vertical|horizontal|grid|page)\s+layout|multiple\s+views|4-?koma)\b/gi;
    return String(text || '')
        .replace(layoutMetaRe, '')
        .replace(/\s*,(\s*,)+/g, ',')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .replace(/\s{2,}/g, ' ');
}

// Danbooru-style tags are ASCII. A macron or accent makes a near-miss token the model
// was never trained on — "shihakusho" is a known garment, "shihakusho" with a macron is
// not the same string, and the field run rendered a modern black dress shirt instead.
// Fold Latin diacritics; leave CJK and everything else untouched.
function foldTagDiacritics(text) {
    return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function softSanitize(text, style) {
    try { return sanitizeBuilderOutput(text, style); } catch { return ''; }
}

// Curly quotes/apostrophes and whitespace runs must not defeat the verbatim check.
function normalizeForMatch(text) {
    return String(text)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        // Em/en dashes are punctuation walls between a bubble and its scene line —
        // 'JOVAN—!' failed verbatim against the scene's own '—JOVAN—!' (field).
        .replace(/[\u2014\u2013]/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

// Verbatim guarantee: a bubble renders only if its text literally occurs in the
// scene — invented dialogue can never reach the image. Order matters: verify
// FIRST, length-trim SECOND (a prefix of verified text is still verbatim; a
// trimmed string checked against the scene is not the same guarantee).
// The speaker's-face law is only enforceable if this function knows who is in the
// frame. It never received `who`, so a panel could carry a line shouted by someone who
// was never drawn — a balloon with a tail pointing at nobody.
function sanitizeBubbles(list, sceneText, who) {
    if (!Array.isArray(list)) return [];
    const present = (who || []).map(w => String(w?.name ?? w ?? '').trim().toLowerCase()).filter(Boolean);
    const presentParts = new Set(present.flatMap(n => [n, ...n.split(/\s+/)]).filter(p => p.length >= 3));
    const speakerPresent = (s) => {
        const low = String(s || '').trim().toLowerCase();
        if (!present.length) return true;
        if (!low) return present.length === 1;
        if (presentParts.has(low)) return true;
        return low.split(/\s+/).some(p => p.length >= 3 && presentParts.has(p));
    };
    const sceneNorm = normalizeForMatch(sceneText);
    const out = [];
    for (const b of list) {
        if (out.length >= 2) break;
        const speaker = String(b?.speaker ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        let text = String(b?.text ?? '')
            .replace(/\s+/g, ' ')
            .replace(/^["'\u201C\u2018\s]+|["'\u201D\u2019\s]+$/g, '')
            .replace(/(\.{3}|\u2026)$/, '')
            .trim();
        if (!text) continue;
        if (!sceneNorm || !sceneNorm.includes(normalizeForMatch(text))) continue;
        if (!speakerPresent(speaker)) continue;
        if (text.length > 110) {
            const win = text.slice(0, 110);
            const sentenceEnd = Math.max(win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
            if (sentenceEnd > 40) {
                text = win.slice(0, sentenceEnd + 1).trim();
            } else {
                const cut = win.slice(0, 104);
                const at = cut.lastIndexOf(' ');
                text = (at > 40 ? cut.slice(0, at) : cut).trim() + '\u2026';
            }
        }
        out.push({ speaker, text });
    }
    return out;
}

function parsePanels(raw, style, maxPanels, opts = {}) {
    const wantBubbles = !!opts.bubbles;
    const sceneText = String(opts.sceneText || '');
    const cleaned = String(raw)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\n?|```/gi, '')
        .trim();
    if (maxPanels > 1 || wantBubbles || opts.expectJson) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                const obj = JSON.parse(match[0]);
                const arr = Array.isArray(obj?.panels) ? obj.panels : [];
                const panels = arr
                    .map(p => {
                        // `who` is built first: bubble sanitation needs it to enforce the
                        // speaker's-face law (a line may only be spoken by someone drawn).
                        const who = Array.isArray(p?.who) ? p.who.map(w => {
                            if (w && typeof w === 'object') return { name: String(w.name ?? '').trim(), state: capTagSafe(stripLayoutMeta(String(w.state ?? '')), 500) };
                            return { name: String(w ?? '').trim(), state: '' };
                        }).filter(w => w.name).slice(0, 2) : [];
                        return {
                            sentence: capSentenceSafe(stripLayoutMeta(String(p?.sentence ?? '').replace(/["`\n]+/g, ' ')).replace(/\s{2,}/g, ' '), 220),
                            who,
                            whoDeclared: Array.isArray(p?.who),
                            prompt: normalizeCountTags(softSanitize(typeof p === 'string' ? p : String(p?.prompt ?? ''), style)),
                            bubbles: wantBubbles ? sanitizeBubbles(p?.bubbles, sceneText, who) : [],
                        };
                    })
                    .filter(p => p.prompt)
                    .slice(0, maxPanels);
                if (panels.length) {
                    const capTags = (v, n) => stripLayoutMeta(String(v ?? '')).split(',').map(t => t.trim()).filter(Boolean).slice(0, n).join(', ');
                    panels.setting = stripTransientFromSetting(capTags(obj?.setting, 16));
                    panels.dress = capTags(obj?.dress, 8);
                    return panels;
                }
            } catch { /* fall through to regex recovery */ }
        }
        // Truncated/dirty JSON: recover every completed "prompt":"..." value.
        // Bubbles are dropped on this path — recovered fragments cannot carry the
        // verbatim guarantee, and a clean panel still ships.
        const recovered = [];
        const rx = /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let hit;
        while ((hit = rx.exec(cleaned)) !== null) {
            const text = softSanitize(hit[1].replace(/\\"/g, '"').replace(/\\n/g, ' '), style);
            if (text) recovered.push({ prompt: text, bubbles: [] });
        }
        if (recovered.length) return recovered.slice(0, maxPanels);
    }
    return [{ prompt: sanitizeBuilderOutput(cleaned, style), bubbles: [] }];
}

// Builders emit malformed leading counts ('2boys, 1boy, 1other', '1man') — collapse to
// one canonical expression: first occurrence per class, danbooru gender forms.
function normalizeCountTags(prompt) {
    const toks = String(prompt || '').split(',').map(t => t.trim());
    const isCount = t => /^(?:\d+|multiple)\s*(?:boys?|girls?|others?|men|man|women|woman)$/i.test(t);
    const canon = t => {
        const s = t.toLowerCase().replace(/\s+/g, '')
            .replace(/women$/, 'girls').replace(/woman$/, 'girl')
            .replace(/men$/, 'boys').replace(/man$/, 'boy');
        return s.startsWith('multiple') ? 'multiple ' + s.slice(8) : s;
    };
    const classOf = t => /boys?$/.test(canon(t)) ? 'b' : /girls?$/.test(canon(t)) ? 'g' : 'o';
    let i = 0; const seen = new Set(); const head = [];
    while (i < toks.length && isCount(toks[i])) {
        const c = classOf(toks[i]);
        if (!seen.has(c)) { seen.add(c); head.push(canon(toks[i])); }
        i++;
    }
    if (!head.length) return String(prompt || '');
    return [...head, ...toks.slice(i)].filter(Boolean).join(', ');
}

// Rank garments are per-character, never world dress — filter them from ANY dress
// source (builder field or mined backstop), so the anchor can't dress everyone up.
const RANK_WORD = /\b(?:captain|lieutenant|commander|general|sergeant|colonel|major|marshal|officer|admiral)\b/i;
const DECORATION_WORD = /\b(?:badge|insignia|pin|medal|medals|star|stars|stripe|stripes|epaulettes?|braid|patch|emblem|crest|rank|bars?|chevrons?|armband)\b/i;

// Drop a cast tag that names a rank AND a decoration. This runs on the welded block,
// not just the world dress: the field run kept rendering a lieutenant in a black
// military tunic with collar tabs and an eagle because her own cast line said
// "lieutenant's badge". The garment survives; only the rank decoration goes.
// A cast tag that is just the character's own name (in either order) is a name tag —
// drop it. Sheets built under 0.17.0 carry them; this needs no rebuild to take effect.
function stripNameTags(tagList, characterName) {
    const parts = String(characterName || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (!parts.length) return String(tagList || '');
    const nameWords = new Set(parts);
    const toks = String(tagList || '').split(',').map(t => t.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < toks.length; i++) {
        const w = toks[i].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
        const isName = w.length && w.length <= parts.length && w.every(x => nameWords.has(x));
        if (!isName) { out.push(toks[i]); continue; }
        // 0.17.0 emitted the character tag and the work's tag as a pair ("abarai renji,
        // bleach"). A work tag summons the model's whole cast of that franchise, which is
        // the same failure as the name tag. Drop the single-word partner with it.
        if (i + 1 < toks.length && !/\s/.test(toks[i + 1])) i++;
    }
    return out.join(', ');
}

function stripRankInsignia(tagList) {
    return String(tagList || '').split(',').map(t => t.trim())
        .filter(t => t && !(RANK_WORD.test(t) && DECORATION_WORD.test(t)))
        .join(', ');
}

function filterRankGarments(tagList) {
    return String(tagList || '').split(',').map(t => t.trim())
        .filter(t => t && !/captain|lieutenant|commander|general|sergeant|king|queen|royal/i.test(t))
        .join(', ');
}

// Identity is written by code, not by the builder: look up each "who" name in the cast
// sheet, insert its tag block verbatim, and derive the count tags from the blocks'
// leading gender words. Substitution, omission, blending, and trait drift become
// mechanically impossible for named characters. Placement tags are auto-appended at 3+.
// Builders echo a character's appearance back into "state" and long states get cut
// mid-word — the field run showed 'towering mus' and doubled identity per character.
// Enforcement in code: drop every state token already in the owner's block, drop
// mid-word fragments (a token that is a >=4-char prefix of a block token), and cap
// the result tag-safely — never inside a tag.
// Tags the extension computes itself. If one arrives from the builder inside a state,
// it is not description — it is a competing instruction to the image model.
const CODE_OWNED_TAG = /^(?:(?:\d+\s*(?:boys?|girls?|others?|men|man|women|woman)|multiple\s+(?:boys|girls|others))(?:\s+(?:\d+\s*(?:boys?|girls?|others?|men|man|women|woman)|multiple\s+(?:boys|girls|others)))*|crowd|solo)$/i;

// Count tags echoed into the SHARED prompt ('1boy 1girl' mid-frame, field) are a
// second subject declaration — the exact character-fusion vector. Scrubbed at
// assembly, from every panel, welded or establishing.
const COUNT_TAG_ONLY = /^(?:\d+\s*(?:boys?|girls?|others?|men|man|women|woman)|multiple\s+(?:boys|girls|others))(?:\s+(?:\d+\s*(?:boys?|girls?|others?|men|man|women|woman)|multiple\s+(?:boys|girls|others)))*$/i;

function scrubEchoedCounts(prompt) {
    return String(prompt || '').split(',').map(t => t.trim())
        .filter(t => t && !COUNT_TAG_ONLY.test(t)).join(', ');
}

// A camera UNDERNEATH a lying subject stands them up (field: the afterglow panel
// rendered her standing alone, 'from below' fighting 'lying on back on futon').
const LYING_STATE = /\b(?:lying|supine|on (?:her|his|their) back|flat on|collapsed flat|sprawled|into (?:the )?pillow|on the (?:futon|mattress|bed))\b/i;

// 'under him' is a lying claim without the word: hips 'working in frantic circles
// under him' with no lying cue reads as cowgirl and puts her ON TOP (field). The
// lying tag is derived from the state's own spatial claim.
const UNDER_PARTNER = /\b(?:under|beneath) (?:him|her|them)\b/i;

// Genitals need bodies in frame. A close-up or upper-body crop on an explicit
// two-person panel amputates the partner (field: he vanished from two of six
// panels — the user's law is both partners visible).
function explicitFramingGuard(prompt, explicit, principalCount) {
    if (!explicit || principalCount !== 2) return String(prompt || '');
    return String(prompt || '')
        .replace(/\bclose-?up\b/ig, 'cowboy shot')
        .replace(/\bupper body\b/ig, 'cowboy shot');
}

function inferLyingFromPosition(state) {
    const st = String(state || '');
    if (UNDER_PARTNER.test(st) && !LYING_STATE.test(st)) return `${st}, lying on back`;
    return st;
}

// A garment tag in `state` is a SECOND outfit competing with the one the code welds —
// the field run put "shinigami uniform" beside "black shihakusho" and the model blended
// them into a modern military uniform. Clothing has exactly one source per character.
// Exception: a garment token that also carries a condition word is describing what
// happened TO the clothing (torn, open, removed, blowing), which is state, not wardrobe,
// and the explicit-scene rules depend on it.
const SIZE_WORD = /\b(?:petite|tiny|diminutive|small|little|slight|miniature)\b/i;
const SIZE_NOUN = /\b(?:posture|frame|figure|build|stature|body|form|size|height)\b/i;

const GARMENT_CONDITION = /\b(?:torn|ripped|shredded|tattered|slashed|cut|open|opened|undone|unbuttoned|unfastened|loose|falling|fallen|removed|discarded|missing|soaked|wet|bloodied|bloody|dirty|muddy|burned|burnt|singed|scorched|disheveled|askew|pulled|lifted|hiked|blowing|billowing|fluttering|stirring|flaring|swirling|damaged|half-?off)\b/i;

// The 200-char state cap was silently amputating NSFW states: the explicit-scene
// law demands undress + anatomy + position + fluids per character (300+ chars), so
// nipples and genitals were truncated off the END of the state before the image ever
// saw them (the NSFW regression vs the pre-weld versions, whose builder-written
// prompts had no cap). Explicit states get 420; everyone else keeps 200.
function scrubState(state, blockTags, cap = 200) {
    const blockToks = String(blockTags || '').split(',').map(t => t.trim()).filter(Boolean);
    const blockSet = new Set(blockToks.map(t => t.toLowerCase()));
    // Count tags are computed by code and belong at the head of the prompt. A "1boy"
    // sitting inside a character's block is a SECOND subject declaration mid-prompt: it
    // breaks the contiguous run the weld depends on, and the model cross-binds the two
    // blocks around it. Field: "2boys, <Jovan block>, 1boy, ..., <old man block>, 1boy"
    // rendered one old man with white hair holding the sword. Counts never come from
    // the builder, in any field.
    // A builder that re-states appearance without commas ("tall lean sharp-featured")
    // produces ONE token that matches no single block tag, so exact-token comparison
    // let the whole appearance block through twice. Compare on words, not tokens.
    const blockWords = new Set(blockToks.flatMap(t => t.toLowerCase().split(/[\s-]+/)).filter(Boolean));
    // A 2+ word consecutive phrase from the owner's own block, repeated in their
    // state with extra words around it, is a restatement too — 'medium white hair
    // falling over her chest' survived the word-subset rule, and the third repetition
    // of his white hair in one frame bled onto the black-haired partner (field:
    // white-haired Rukia; the panel-5 fused monster).
    const blockBigrams = new Set();
    for (const bt of blockToks) {
        const w = bt.toLowerCase().split(/[\s-]+/).filter(Boolean);
        for (let i = 0; i + 1 < w.length; i++) blockBigrams.add(w[i] + ' ' + w[i + 1]);
    }
    const out = [];
    let used = 0;
    for (const raw of String(state || '').split(',')) {
        const t = raw.trim();
        if (!t) continue;
        const low = t.toLowerCase();
        if (blockSet.has(low)) continue;
        if (CODE_OWNED_TAG.test(low)) continue;
        if (hasGarment(low) && !GARMENT_CONDITION.test(low)) continue;
        if (blockBigrams.size) {
            const w = low.split(/[\s-]+/).filter(Boolean);
            let phraseHit = false;
            for (let i = 0; i + 1 < w.length; i++) {
                if (blockBigrams.has(w[i] + ' ' + w[i + 1])) { phraseHit = true; break; }
            }
            // Hair-identity restatements are the cross-binding agent — the third
            // 'medium white hair' in a frame bleeds onto the black-haired partner
            // (field: white-haired Rukia). Gaze/expression tokens with an embedded
            // trait stay: they carry the acting, and eyes rarely bleed.
            if (phraseHit && /\b(?:hair|ponytail|twintails|ahoge|bangs)\b/.test(low)
                && !(GARMENT_CONDITION.test(low) && hasGarment(low))) continue;
        }
        if (low.length >= 4 && blockToks.some(b => b.toLowerCase() !== low && b.toLowerCase().startsWith(low))) continue;
        const words = low.split(/[\s-]+/).filter(Boolean);
        if (words.length >= 2 && words.every(w => blockWords.has(w))) continue;
        if (SIZE_WORD.test(low) && SIZE_WORD.test(String(blockTags || ''))
            && (words.length === 1 || SIZE_NOUN.test(low))) continue;
        if (low.length < 3) continue;
        if (used + t.length + 2 > cap) break;
        out.push(t);
        used += t.length + 2;
    }
    return out.join(', ');
}

// Tag-safe truncation: an overlong tag list is cut at the last complete tag,
// never mid-word — mid-word fragments ('towering mus') poison prompts.
// The composition sentence is prose. A hard slice ends a panel mid-word ("as the ,"),
// which the image model reads as a dangling instruction. Cut at the last sentence end,
// else the last word boundary, and never leave trailing punctuation behind.
function capSentenceSafe(text, n) {
    const s = String(text || '').trim();
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (stop > n * 0.5) return cut.slice(0, stop + 1).trim();
    const at = cut.lastIndexOf(' ');
    return (at > 0 ? cut.slice(0, at) : cut).replace(/[\s,;:—-]+$/, '').trim() + '.';
}

function capTagSafe(text, n) {
    const s = String(text || '');
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const at = cut.lastIndexOf(',');
    return (at > 0 ? cut.slice(0, at) : cut).trim();
}

// "(appearance unknown — fill in)" lines are empty slots, not entries: they must
// never block re-seeding and never leak junk tags into a prompt.
function isPlaceholderTags(tags) {
    return /\(appearance unknown/i.test(String(tags || ''));
}

function stripPlaceholderLines(sheetText) {
    return String(sheetText || '').split('\n').filter(l => !isPlaceholderTags(l)).join('\n');
}

// A figure the builder itself placed far away is scenery, not a principal. Welding a
// full verbatim appearance block onto it spends a subject slot and a count on someone
// the frame renders three pixels tall — the model answers by splitting its attention
// and both subjects come out degraded.
// A figure the builder itself framed only as "seen from behind" is scenery too:
// the field run kept such a figure as a second principal and the model resolved
// the two-person frame by floating his blade across the PRIMARY's neck.
const BACKGROUND_STATE = /\b(?:in the (?:far )?(?:background|distance)|at a distance|at distance|far (?:away|off|behind|in the)|distant|from afar|tiny in|small in the frame|seen from (?:behind|above|below|afar))\b/i;

// Principals get identity blocks and counts; background figures get one shared tag.
// Never returns zero principals: a frame with no subject is not a frame.
// Explicit frames: never demote. A partner "seen from behind" IS the position, not
// scenery — the 0.25.0 demotion broke NSFW positioning by turning partners into
// 'distant figure' (field regression). One anatomy/position tag anywhere in the
// frame's states marks it explicit.
const EXPLICIT_STATE = /\b(?:nude|naked|nipples?|areolae?|breasts?|penis|erection|testicles?|pussy|vulva|vagina|anus|anal|sex|orgasm|clitoris|labia|pubic|cum|semen|creampie|fellatio|paizuri|cunnilingus|doggystyle|cowgirl|missionary|thrusting|fucking|grinding|cock|dick)\b/i;

function splitPrincipals(who) {
    const list = (who || []).filter(w => w && String(w.name || '').trim());
    if (list.some(w => EXPLICIT_STATE.test(String(w?.state || '')))) return { principals: list, background: [] };
    const fore = list.filter(w => !BACKGROUND_STATE.test(String(w.state || '')));
    const back = list.filter(w => BACKGROUND_STATE.test(String(w.state || '')));
    if (!fore.length && back.length) return { principals: [back[0]], background: back.slice(1) };
    return { principals: fore, background: back };
}

// A demoted background figure's STATE is demoted with it. 0.21.0 replaced the whole
// entry with the constant "distant figure in the background", which threw the figure's
// action away — the raised sky-blue blade floated free in the shared prompt and the
// image model bound it to the only person left in the frame (field: the saluting old
// man rendered HOLDING the sword, in black, because the blade's colour died with the
// demoted state). The demotion now carries the figure's action along, scrubbed of
// appearance and garments: a background figure gets no second identity, only its verb.
function backgroundFigureTag(background, sheetText) {
    const byName = new Map(parseCastSheet(sheetText).map(c => [c.name.toLowerCase(), c]));
    const bits = [];
    for (const w of (background || []).slice(0, 2)) {
        const hit = byName.get(String(w?.name || '').trim().toLowerCase());
        // Locatives belong to the wrapper, not the action — the field run shipped
        // "seen from behind and below in the background in the background".
        const action = scrubState(String(w?.state || ''), hit ? hit.tags : '')
            .split(',').map(t => t.trim())
            .filter(t => t && !/\bbackground\b/i.test(t) && !/^seen from\b/i.test(t));
        if (action.length) bits.push(action.join(', '));
    }
    const act = capTagSafe(bits.join(', '), 120);
    return act ? `distant figure ${act} in the background` : 'distant figure in the background';
}

// Environment facts have exactly ONE owner: the world anchor (setting + dress),
// stamped once per panel by appendAnchor. The builder keeps restating the whole
// location block inside every panel's shared prompt (field: the same 15-tag
// courtyard block in all four frames of one strip), which tripled prompt length,
// drowned the character state tags, and — with atmosphere tags stacked three deep —
// flattened the crowd into grey fog and then into nobody at all. Enforcement mirrors
// scrubState: a shared-prompt token that restates an anchor token (exact, or every
// word already owned by the anchor) is dropped, and the anchor's canonical wording is
// what gets stamped. Self-duplicates inside the prompt go too. Runs ONLY on the
// shared prompt — never on identity blocks, which own their tags outright.
function dedupeAgainstAnchor(prompt, anchor) {
    const anchorToks = String(anchor || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    const anchorSet = new Set(anchorToks);
    const anchorWords = new Set(anchorToks.flatMap(t => t.split(/[\s-]+/)).filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const raw of String(prompt || '').split(',')) {
        const t = raw.trim();
        if (!t) continue;
        const low = t.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        if (anchorSet.has(low)) continue;
        const words = low.split(/[\s-]+/).filter(Boolean);
        if (words.length >= 2 && words.every(w => anchorWords.has(w))) continue;
        out.push(t);
    }
    return out.join(', ');
}

// A welded cast block dresses every character. In an explicit frame the state says
// what came OFF, and a welded garment fights the anatomy — the model draws clothes
// over it (NSFW field regression: a welded 'black dress' beside 'nipples' rendered
// the dress ON). 'nude'/'naked' in the state strips every garment token from the
// block; a condition token ('dress removed', 'shirt open') strips just that garment.
function applyUndress(blockTags, state) {
    const blockToks = String(blockTags || '').split(',').map(t => t.trim()).filter(Boolean);
    const st = String(state || '');
    if (!st.trim()) return blockToks.join(', ');
    if (/\b(?:completely |fully |totally )?(?:nude|naked)\b/i.test(st)) {
        return blockToks.filter(t => !hasGarment(t)).join(', ');
    }
    const off = new Set();
    for (const tok of st.toLowerCase().split(',')) {
        if (!GARMENT_CONDITION.test(tok)) continue;
        for (const w of tok.split(/[\s-]+/)) {
            if (GARMENT_WORDS.some(g => w === g || w === g + 's')) off.add(w);
        }
    }
    if (!off.size) return blockToks.join(', ');
    return blockToks.filter(t => ![...off].some(w => t.toLowerCase().includes(w))).join(', ');
}

function assembleIdentity(who, sheetText, opts = {}) {
    const cast = parseCastSheet(sheetText);
    const byName = new Map(cast.map(c => [c.name.toLowerCase(), c]));
    const blocks = [];
    const missing = [];
    for (const entry of (who || []).slice(0, 2)) {
        const name = typeof entry === 'object' && entry ? String(entry.name ?? '') : String(entry ?? '');
        const state = typeof entry === 'object' && entry ? String(entry.state ?? '').trim() : '';
        const hit = byName.get(name.trim().toLowerCase());
        if (hit && !isPlaceholderTags(hit.tags)) {
            const tags = neutralizeRoleUniforms(stripRankInsignia(stripNameTags(hit.tags, hit.name)), opts.worldDress || opts.dress);
            const scrubbed = stripRankInsignia(scrubState(state, tags, EXPLICIT_STATE.test(state) ? 420 : 200));
            // A state of undress UNDRESSES the weld, or the welded garment wins.
            const dressed = applyUndress(tags, scrubbed);
            // A character the state undressed never gets re-dressed by the world
            // (the gate caught the weld putting a blazer on a 'completely nude').
            const undressing = dressed !== tags
                || /\b(?:completely |fully |totally )?(?:nude|naked)\b/i.test(scrubbed);
            // Clothing is identity too: if neither the sheet nor the state dresses this
            // character, the world's base outfit is welded in rather than left to priors.
            // It goes BEFORE the state — the tail of a block is the weakest position,
            // and a t-shirt prior beat a trailing 'black shihakusho' (field). In a
            // world the anti-modern gate fires on, the garment is emphasis-braced.
            const worldDress = String(opts.dress || '').trim();
            const needsDress = !undressing && !hasGarment(dressed) && !hasGarment(scrubbed) && worldDress;
            const clothing = needsDress ? worldDress : '';
            blocks.push([dressed, clothing, scrubbed].filter(Boolean).join(', '));
        }
        else missing.push(name.trim() || '(unnamed)');
    }
    // The count run is read in order against the blocks that follow it. Emitting a fixed
    // boy-then-girl order while the blocks run woman-then-man tells the model the first
    // described figure is the boy — the field run returned a red-haired woman with a
    // man's tattoos and chest. Counts follow block order, always.
    const kinds = blocks.map(b => {
        const first = String(b).split(',')[0].trim().toLowerCase();
        if (/\b(?:woman|girl|female)\b/.test(first)) return 'g';
        if (/\b(?:man|boy|male)\b/.test(first)) return 'b';
        return 'o';
    });
    const seen = [];
    for (const k of kinds) if (!seen.includes(k)) seen.push(k);
    const nOf = k => kinds.filter(x => x === k).length;
    const label = (k, n) => k === 'g' ? (n === 1 ? '1girl' : n + 'girls')
        : k === 'b' ? (n === 1 ? '1boy' : n + 'boys')
            : (n === 1 ? '1other' : n + 'others');
    const counts = seen.map(k => label(k, nOf(k))).join(', ');
    return { counts, blocks, missing };
}

// Escape a name for RegExp embedding. Top-level on purpose: this class once
// shipped with stray letters spliced in (any name containing 't' compiled to a
// tab and silently never matched). Canonical, behavior-tested, never inlined.
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names are semantic zeros to tag-native image models. Sentences must speak in role
// words; any cast name that leaks in is substituted by the character's gender word.
function replaceNamesInSentence(sentence, sheetText) {
    let out = String(sentence || '');
    if (!out) return out;
    for (const c of parseCastSheet(sheetText)) {
        const first = String(c.tags).split(',')[0].trim().toLowerCase();
        const gm = first.match(/\b(woman|girl|female|man|boy|male)\b/);
        const role = gm ? (gm[1] === 'female' ? 'the woman' : gm[1] === 'male' ? 'the man' : `the ${gm[1]}`) : 'the figure';
        const parts = c.name.split(/\s+/).filter(Boolean);
        for (const token of [c.name, ...parts]) {
            if (token.length < 3) continue;
            out = out.replace(new RegExp(`\\b${escRe(token)}\\b`, 'g'), role);
        }
    }
    return out.replace(/\b(the (?:man|woman|boy|girl|figure))( and \1)+\b/g, '$1').replace(/\s{2,}/g, ' ');
}

// Per-panel seed: derived from the run seed and WHO is in the frame. Same who-set,
// same seed — a recurring character renders consistently. Different who-set, different
// seed — a locked seed's palette priors can no longer bleed one panel's white hair
// onto the next panel's black-haired girl (field bug).
// When the world's dress is traditional and nothing modern is declared, seeds can
// still roll modern-uniform latents that outvote the anchor (field bug: Prussian
// tunics over 'black kosode'). Derive an anti-modern negative FROM the dress data —
// world-agnostic: it only fires on what the user's own world declares.
function antiModernNegative(dress) {
    const d = String(dress || '').toLowerCase();
    const traditional = ['kimono', 'kosode', 'hakama', 'haori', 'shihakush', 'yukata', 'robe', 'obi', 'sash'];
    const modern = ['necktie', 'suit', 'blazer', 'hoodie', 't-shirt', 'jeans', 'jacket', 'trench'];
    if (traditional.some(t => d.includes(t)) && !modern.some(m => d.includes(m))) {
        return 'modern military uniform, epaulettes, necktie, medals, dress shirt, buttons coat, peaked cap, '
            + 'school uniform, gakuran, blazer, pleated skirt, sailor collar, serafuku, business suit, hoodie, '
            + 'glass building, concrete building, skyscraper, modern architecture, power lines, streetlight, asphalt road, '
            + 'military uniform, shoulder boards, collar tabs, eagle insignia, aiguillette, sam browne belt, jodhpurs, '
            + 'nazi, swastika, iron cross, wehrmacht, ss uniform, gestapo, armband with emblem, military cap';
    }
    return '';
}

// A 'uniform' token names a role, not a garment. In a traditional-dress world it is
// the modern-military blend engine — the field run welded the auto-built cast's
// 'shinigami uniform' into every block and rendered black gakuran with gold buttons
// over a 'black shihakusho' world, positive overriding the anti-modern negative.
// scrubState already drops role-uniforms from STATE (uniform is a garment word);
// the cast block had no such guard. When the anti-modern gate fires for the world,
// 'uniform'-bearing tokens are removed from welded cast blocks in code; the world's
// own first garment takes their place via the existing undressed-principal weld.
// A plain visible garment survives: only the word 'uniform' triggers this.
function neutralizeRoleUniforms(tags, worldDress) {
    if (!antiModernNegative(worldDress)) return String(tags || '');
    return String(tags || '').split(',').map(t => t.trim())
        .filter(t => t && !/\buniforms?\b/i.test(t))
        .join(', ');
}

function seedForPanel(runSeed, whoNames, identityWelded) {
    // Subject-derived seeds (0.12.5) stopped palette priors bleeding between panels with
    // different subjects — from when the BUILDER wrote appearance. Identity is now welded
    // verbatim from the cast sheet into every panel (0.13.0), which pins subject appearance
    // far harder than seed decorrelation ever did. Meanwhile nothing pins the location: a
    // fresh seed per panel re-rolls the architecture of a strip that is supposed to be one
    // continuous place, and the field run produced three different buildings for one
    // courtyard. Welded panels share the run seed; the who-hash remains the backstop for
    // panels whose identity the code does NOT own.
    if (identityWelded) return (runSeed >>> 0) % 2147483647;
    let h = 0;
    for (const n of (whoNames || []).map(x => String(x).toLowerCase()).sort()) {
        for (let i = 0; i < n.length; i++) h = ((h * 31) + n.charCodeAt(i)) >>> 0;
    }
    return ((runSeed >>> 0) ^ h) % 2147483647;
}

// Append anchor tags to a prompt without duplicating tokens the prompt already has.
// Does this frame's own text put a crowd in it? Read from the stamped anchor and the
// panel's shared prompt — the same words the image model will read.
function framesCrowd(text) {
    return /\b(?:crowds?|crowded|audience|spectators?|onlookers?|bystanders?|throngs?|thronged|mob|multitude|packed|rows of|ranks of|lined with|standing officers|three hundred)\b/i.test(String(text || ''));
}

// Crowd presence is positional (use_order: true): a crowd named only in the anchor
// tail is the ~50th token and the model treats it as weather — the field run shipped
// three principals against empty backgrounds while the crowd sat in the tail. When
// the frame HAS a crowd, the anchor's own crowd words are hoisted to directly after
// the identity blocks. Same words, front position; appendAnchor dedupes the tail.
// 'crowded hall of students', 'hundreds of seated students', 'students frozen
// mid-bite' — the field's anchor population was invisible to a crowd-only regex,
// nothing hoisted, and the refectory rendered EMPTY.
const CROWD_ANCHOR_TOKEN = /\b(?:crowds?|crowded|spectators?|audience|onlookers?|bystanders?|throngs?|mob|multitude|packed|ranks|students?|pupils?|hundreds?|dozens?|people|villagers?|townsfolk|patrons?|customers?|guests?)\b/i;

function hoistCrowdTokens(anchor, crowdHere) {
    if (!crowdHere) return '';
    return String(anchor || '').split(',').map(t => t.trim())
        .filter(t => t && CROWD_ANCHOR_TOKEN.test(t)).join(', ');
}

// Crowd tokens carrying ACTIONS ('dispersing crowd laughing', 'retreating shinigami')
// are the ones that give a crowd life — the user-facing standard is the laughing,
// retreating crowd, not a static packed mass. They are split out of the panel prompt
// so they can ride directly after the identity blocks, position-forward.
function extractCrowdTokens(prompt) {
    const crowd = [];
    const rest = [];
    for (const raw of String(prompt || '').split(',')) {
        const t = raw.trim();
        if (!t) continue;
        (CROWD_ANCHOR_TOKEN.test(t) ? crowd : rest).push(t);
    }
    return { crowd: crowd.join(', '), rest: rest.join(', ') };
}

// Role words summon modern armies. 'soldiers'/'officers' in a positive prompt beat
// the anti-modern negative every time (field: green modern military uniforms behind
// a shihakusho crowd). When the anti-modern gate fires, role tokens are purged from
// prompts, states, and the setting — the anchor's own population words ('shinigami
// in black shihakusho') name these people instead.
// Sex acts, including the euphemisms builders hide behind, and genital anatomy.
const SEX_ACT = /\b(?:thrust(?:ing|s)?|missionary|doggystyle|doggy style|cowgirl|vaginal|anal sex|fucking|intercourse|penetrat\w*|orgasm\w*|climax\w*|driv\w+ deep|buried (?:deep|inside|in (?:her|him|them))|still joined|impal\w*|balls?[- ]deep|mating press|prone bone|riding|straddling|pounding|slamming|ejaculat\w*|creampie)\b/i;
const GENITAL_TAG = /\b(?:penis|erection|testicles?|cock|dick|pussy|vulva|vagina|clitoris|labia|anus)\b/i;

// A panel fails when it depicts a sex act — however euphemized — with zero genital
// tags anywhere the model can read them.
function panelLacksAnatomy(p) {
    const text = [p?.prompt, p?.sentence, ...(p?.who || []).map(w => String(w?.state ?? w ?? ''))].join(' ');
    return SEX_ACT.test(text) && !GENITAL_TAG.test(text);
}

// A garment worn by exactly ONE named character is THAT character's clothing, never
// the world's dress — the hero's black kosode was mined as 'world dress' and welded
// onto the heroine (field). Garments appearing in 2+ cast lines are the world's
// shared outfit and stay; single-owner garments are dropped from the dress field.
// The world's dress field itself needs hygiene: 'uniform' tokens die in a
// traditional world (the gakuran engine), and decorations ('3rd seat armband',
// badges, insignia) are per-character rank marks — never something every background
// person wears.
function cleanWorldDress(dressText, antiModernOn) {
    let d = String(dressText || '');
    if (antiModernOn) d = d.split(',').map(t => t.trim()).filter(t => t && !/\buniforms?\b/i.test(t)).join(', ');
    return d.split(',').map(t => t.trim()).filter(t => t && !DECORATION_WORD.test(t)).join(', ');
}

function stripPersonalGarments(dressText, castText) {
    const counts = new Map();
    for (const line of String(castText || '').split('\n')) {
        const tags = line.split(':').slice(1).join(':');
        const seenLine = new Set();
        for (const t of tags.split(',')) {
            const low = t.trim().toLowerCase();
            if (!low || seenLine.has(low)) continue;
            if (GARMENT_WORDS.some(g => low.includes(g))) { seenLine.add(low); counts.set(low, (counts.get(low) || 0) + 1); }
        }
    }
    return String(dressText || '').split(',').map(t => t.trim())
        .filter(t => {
            if (!t) return false;
            const low = t.toLowerCase();
            if (!GARMENT_WORDS.some(g => low.includes(g))) return true;
            return (counts.get(low) || 0) !== 1;
        }).join(', ');
}

const MODERN_ROLE = /\b(?:soldiers?|troop|troops|army|military|marines?|sailors?|police|officers?|security)\b/i;

function purgeModernRoles(text) {
    return String(text || '').split(',').map(t => t.trim())
        .filter(t => t && !MODERN_ROLE.test(t)).join(', ');
}

// The law mandates exactly ONE framing tag and ONE angle tag per panel. A law the code
// cannot enforce is not a law: the field run shipped "low angle, full body, wide shot"
// and the model split the difference into a wide shot with unreadable figures. First
// of each kind wins; the rest are dropped.
const FRAMING_TAG = /^(?:close-?up|extreme close-?up|face close-?up|portrait|bust shot|upper body|cowboy shot|medium shot|full body|wide shot|extreme wide shot|establishing shot)$/i;
const ANGLE_TAG = /^(?:from below|from above|from behind|from side|from front|eye level|low angle|high angle|dutch angle|bird's-eye view|worm's-eye view|overhead shot)$/i;

function enforceShotGrammar(prompt) {
    let framing = false, angle = false;
    const out = [];
    for (const raw of String(prompt || '').split(',')) {
        const t = raw.trim();
        if (!t) continue;
        // Builder emphasis braces make a framing tag invisible to the regex —
        // '{cowboy shot}' matched nothing, the panel ran with NO recognized framing,
        // and a dutch angle over a close crop amputated the partner (field).
        const bare = t.replace(/[{}]/g, '').trim();
        if (FRAMING_TAG.test(bare)) { if (framing) continue; framing = true; }
        else if (ANGLE_TAG.test(bare)) { if (angle) continue; angle = true; }
        out.push(t);
    }
    return out.join(', ');
}

// One strip, one sky. The anchor owns the time of day; a panel that names its own
// light contradicts it, and the strip flickers blue-night / warm-day / purple-dusk
// across one continuous minute (field: the same courtyard rendered as full-moon
// night in panel 1, warm noon in panel 2, purple dusk in panel 3). When the anchor
// carries any light token, panel-level light tokens are dropped in code. Shot
// atmosphere that is not a time of day (lens flare, wind, dust, dramatic lighting)
// is untouched.
const LIGHT_TOKEN = /\b(?:sunlight|sun|sunny|daylight|moonlight|moonlit|moon|night|nighttime|evening|dusk|dawn|twilight|morning|winter light|backlight(?:ing)?|backlit|golden hour|rim light|sunset|sunrise|candlelight|firelight|lamplight)\b/i;

function unifyStripLighting(prompt, anchor) {
    if (!LIGHT_TOKEN.test(String(anchor || ''))) return String(prompt || '');
    return String(prompt || '').split(',').map(t => t.trim())
        .filter(t => t && !LIGHT_TOKEN.test(t))
        .join(', ');
}

// What a population is momentarily DOING cannot live in a description stamped unchanged
// onto every panel. Strip the activity, keep the population and its dress: "dispersing
// crowd of shinigami in black shihakusho" -> "crowd of shinigami in black shihakusho".
const TRANSIENT_ACTIVITY = /\b(?:dispersing|scattering|leaving|departing|exiting|arriving|entering|gathering|filing|marching|fleeing|running|walking|streaming|cheering|chanting|roaring|shouting|applauding|clapping|celebrating|mourning|weeping|kneeling|bowing|saluting|erupting|surging|charging|rushing|dancing|drinking|eating|fighting)\s+/gi;

function stripTransientFromSetting(setting) {
    return String(setting || '').split(',').map(t => t.replace(TRANSIENT_ACTIVITY, '').trim())
        .filter(Boolean).join(', ');
}

// Parse the plan pass. Small, strict, and never throws — a plan that will not parse
// simply means the caller falls back to the single-call builder.
function parsePlan(raw, maxPanels) {
    const cleaned = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json\n?|```/gi, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let obj;
    try { obj = JSON.parse(match[0]); } catch { return null; }
    const arr = Array.isArray(obj?.plan) ? obj.plan : [];
    const panels = arr.map(p => ({
        beat: stripLayoutMeta(String(p?.beat ?? '').replace(/["`\n]+/g, ' ')).replace(/\s{2,}/g, ' ').trim().slice(0, 200),
        between: String(p?.between ?? '').replace(/["`\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200),
        follows: String(p?.follows ?? '').replace(/["`\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200),
        who: Array.isArray(p?.who) ? p.who.map(w => String(typeof w === 'object' && w ? w.name ?? '' : w ?? '').trim()).filter(Boolean).slice(0, 2) : null,
    })).filter(p => p.beat).slice(0, maxPanels);
    if (!panels.length) return null;
    return { setting: String(obj?.setting ?? '').trim(), dress: String(obj?.dress ?? '').trim(), panels };
}

// How many beats does the scene HAVE? The builder's answer to this has been wrong
// for six versions (a 9-beat scene compressed to 2 panels, repeatedly). Code counts
// candidate beats from the prose — a paragraph with action or dialogue is a beat —
// and the builder must render ALL of them, up to the panel budget. Scene-driven,
// not builder-mood-driven.
function countSceneBeats(scene) {
    const paras = String(scene || '').split(/\n+/).map(s => s.trim())
        .filter(s => s.length > 20 && !s.startsWith('[') && !/^~t~/.test(s));
    let beats = 0;
    for (const p of paras) {
        if (/"[^"]{2,}"/.test(p) || /[.!?…]/.test(p)) beats++;
    }
    return beats;
}

// The world dress never rides the anchor of an explicit panel: 'shihakusho, kosode'
// stamped after a nude scene's sentence is how clothes creep back onto bare skin.
function dressForPanel(dress, explicit) {
    return explicit ? '' : String(dress || '');
}

// Anatomy continuity across a strip: once a strip establishes nipples/genitals, no
// later panel amputates them — the finale rendered a bare breast with NO nipple
// because 'nipples' was missing from THAT panel alone (field). Inheritance, not
// invention: tokens come only from the strip's own earlier states.
function anatomyContinuity(state, stripAnatomy) {
    const st = String(state || '');
    const low = st.toLowerCase();
    const add = [];
    if (/\bbreasts?\b/.test(low) && !/\bnipples?\b/.test(low) && stripAnatomy.has('nipples')) add.push('nipples');
    if (/\b(?:legs (?:spread|fallen) open|spread legs|between (?:her|his) (?:legs|thighs))\b/.test(low)
        && !/\b(?:pussy|vulva|vagina)\b/.test(low) && stripAnatomy.has('pussy')) add.push('pussy');
    return add.length ? `${st}, ${add.join(', ')}` : st;
}

// Two beats are the same beat when their content words mostly coincide. This is the
// check that catches a sword leaving its sheath followed by that same sword overhead.
const BEAT_STOPWORD = /^(?:the|a|an|and|or|but|as|at|in|on|of|to|his|her|their|its|with|while|over|into|from|for|by|is|are|was|were|he|she|they|it|this|that|up|down|out)$/i;
function beatWords(beat) {
    return new Set(String(beat || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(w => w.length > 2 && !BEAT_STOPWORD.test(w)));
}
function beatsAreTheSame(a, b) {
    const A = beatWords(a), B = beatWords(b);
    if (A.size < 2 || B.size < 2) return false;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / Math.min(A.size, B.size) >= 0.6;
}

// Everything the plan can get wrong that a human would catch by reading the list. Each
// problem is returned as a sentence the repair call can act on directly.
function validatePlan(plan, castNames, maxPanels, opts = {}) {
    const problems = [];
    const known = new Set((castNames || []).map(n => n.toLowerCase()));
    if (maxPanels > 1 && plan.panels.length < 2) problems.push('You returned fewer than 2 panels; a strip needs at least 2.');
    if (maxPanels >= 4 && plan.panels.length <= 2) problems.push(`You used only ${plan.panels.length} panels of a ${maxPanels}-panel budget. Read the scene again — its text holds more distinct beats than that. Give each its own panel, up to the budget.`);
    if ((opts.beatCount || 0) >= 2 && plan.panels.length < opts.beatCount) problems.push(`The scene's prose contains ${opts.beatCount} distinct beats (counted by code) and you returned ${plan.panels.length} panels. Render every beat, in scene order.`);
    for (let i = 0; i < plan.panels.length; i++) {
        const p = plan.panels[i];
        if (p.who === null) problems.push(`Panel ${i + 1} has no "who" field at all. Every panel must have one, even if it is [].`);
        for (const n of (p.who || [])) {
            if (known.size && !known.has(n.toLowerCase())) problems.push(`Panel ${i + 1} names "${n}", who is not in the cast sheet. Use an exact cast-sheet name or drop them.`);
        }
        if ((p.who || []).length === 2 && !p.between) problems.push(`Panel ${i + 1} puts ${p.who.join(' and ')} in one frame without saying what passes between them. Two people share a frame only when the beat is an action between them — if you cannot name it, this is two panels or one.`);
        if (i > 0 && !p.follows) problems.push(`Panel ${i + 1} does not say how it follows panel ${i}. Every panel after the first must state what makes it the next moment — a panel that does not follow the one before it is an independent picture, not a strip.`);
        if (i > 0 && p.follows && beatsAreTheSame(p.follows, p.beat)) problems.push(`Panel ${i + 1}'s "follows" just restates its own beat. Say what changed since panel ${i}.`);
        if (i > 0 && (p.who || []).length === 1 && (plan.panels[i - 1].who || []).length === 1
            && p.who[0].toLowerCase() === plan.panels[i - 1].who[0].toLowerCase()) {
            problems.push(`Panels ${i} and ${i + 1} are both ${p.who[0]} alone. One continuous action does not get two frames — merge them into the stronger image and give the freed panel to a beat, or a character, the strip is not covering.`);
        }
        for (let j = i + 1; j < plan.panels.length; j++) {
            if (beatsAreTheSame(p.beat, plan.panels[j].beat)) problems.push(`Panels ${i + 1} and ${j + 1} are the same beat. Replace one with a beat the strip does not already cover.`);
        }
    }
    // The all-solo strip: 0.16.0 shipped one and it threw the scene away.
    const named = plan.panels.filter(p => (p.who || []).length);
    if (named.length >= 3 && named.every(p => p.who.length === 1) && (castNames || []).length >= 2) {
        problems.push('Every panel is a single person. If any beat in this scene is an action BETWEEN two people, that panel must list both.');
    }
    // Pure crowd frames fail in the field (empty halls, tiny people, scale insanity)
    // while crowds behind a principal render every time. When named characters exist,
    // a crowd-reaction beat needs a foreground witness, not "who": [].
    if (opts.crowd && (castNames || []).length && plan.panels.some(p => Array.isArray(p.who) && p.who.length === 0)) {
        problems.push('A panel is "who": [] — a bare crowd frame. Pure crowd frames render empty or insane; give the crowd beat ONE foreground witness (the principal whose reaction carries it) and show the crowd behind them.');
    }
    if (opts.crowd && plan.panels.length >= 3 && (castNames || []).length
        && !plan.panels.some(p => /crowd|erupt|hundreds|voices|roar|chant|cheer|spectators/i.test(p.beat))) {
        problems.push('This scene has a crowd reacting and no panel shows it. Give one panel a foreground witness with the crowd reacting behind them.');
    }
    return problems;
}

function appendAnchor(prompt, anchor) {
    const base = String(prompt || '');
    // Emphasis syntax is invisible to ownership: a braced '{black shihakusho}' IS the
    // anchor's 'black shihakusho' and must not be re-stamped at the tail.
    const bare = t => t.trim().toLowerCase().replace(/[{}]/g, '').replace(/^-?\d+(?:\.\d+)?::/, '').replace(/::\s*$/, '').trim();
    const have = new Set(base.split(',').map(bare).filter(Boolean));
    const add = String(anchor || '').split(',').map(t => t.trim()).filter(t => t && !have.has(bare(t)));
    return add.length ? `${base}, ${add.join(', ')}` : base;
}

// Backstop when the builder returns no dress field: the cast sheet IS the world's
// wardrobe. Mine garment-bearing tags (generic garment lexicon, not world-specific).
const GARMENT_WORDS = ['kimono', 'kosode', 'hakama', 'haori', 'shihakusho', 'shihakush\u014d', 'sash', 'obi', 'uniform', 'armband', 'robe', 'cloak', 'cape', 'coat', 'dress', 'skirt', 'scarf', 'hat', 'gloves', 'boots', 'suit', 'tunic', 'armor', 'vest', 'shirt', 'trousers', 'pants'];

// A cast entry with no garment tag is an undressed principal, and the image model
// dresses them from its own priors — which is how a shinigami lieutenant came back
// wearing a school blazer. The world's dress is known; use it.
function hasGarment(tags) {
    const low = String(tags || '').toLowerCase();
    return GARMENT_WORDS.some(g => low.includes(g));
}

// The first wearable tag of the world's dress, for binding to the crowd.
function firstGarmentTag(dress) {
    for (const t of String(dress || '').split(',').map(x => x.trim()).filter(Boolean)) {
        if (hasGarment(t)) return t;
    }
    return '';
}

function mineDressTags(castText) {
    const garments = GARMENT_WORDS;
    const seen = new Set();
    const out = [];
    for (const line of String(castText || '').split('\n')) {
        const tags = line.split(':').slice(1).join(':');
        for (const t of tags.split(',')) {
            const tag = t.trim();
            const low = tag.toLowerCase();
            if (!tag || seen.has(low)) continue;
            // Rank/status garments are per-character, not world dress — stamping them on
            // everyone dressed a no-insignia protagonist in a captain's haori (field bug).
            if (/captain|lieutenant|commander|general|sergeant|king|queen|royal/.test(low)) continue;
            if (garments.some(g => low.includes(g))) { seen.add(low); out.push(tag); }
        }
    }
    return out.slice(0, 10).join(', ');
}

function effectiveForcedTags() {
    const cur = String(settings.forcedTags || '').trim();
    if (cur === defaultSettings.forcedTags.trim() && BACKEND_QUALITY[settings.backend]) return BACKEND_QUALITY[settings.backend];
    return cur;
}

function effectiveNegative() {
    const cur = String(settings.negativePrompt || '').trim();
    if (cur === defaultSettings.negativePrompt.trim() && BACKEND_NEGATIVE[settings.backend]) return BACKEND_NEGATIVE[settings.backend];
    return cur;
}

function composePositive(built, style) {
    built = foldTagDiacritics(built);
    const forced = effectiveForcedTags();
    if (!forced) return built;
    if (style === 'natural') return `${built} ${forced.split(',').map(s => s.trim()).filter(Boolean).join(', ')}.`.trim();
    const have = new Set(built.toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
    const add = forced.split(',').map(s => s.trim()).filter(s => s && !have.has(s.toLowerCase()));
    return add.length ? `${built}, ${add.join(', ')}` : built;
}

function parseCastSheet(sheetText) {
    const map = [];
    for (const raw of String(sheetText || '').split('\n')) {
        const line = raw.trim();
        if (!line || line.indexOf(':') === -1) continue;
        const name = line.slice(0, line.indexOf(':')).trim();
        const tags = line.slice(line.indexOf(':') + 1).trim();
        if (name && tags) map.push({ name, tags });
    }
    return map;
}

function stripScene(text) {
    let scene = String(text || '');
    for (const line of String(settings.stripPatterns || '').split('\n')) {
        const pattern = line.trim();
        if (!pattern) continue;
        try {
            scene = scene.replace(new RegExp(pattern, 'gi'), '');
        } catch (e) {
            console.warn('[SceneSnap] invalid strip pattern skipped:', pattern, e);
        }
    }
    return scene.replace(/\n{3,}/g, '\n\n').trim();
}

// Pure: scan structured presence markers. When markers exist they are the
// authoritative attendance list — mention is not presence.
function scanPresenceIn(text, onSrc, offSrc) {
    const grab = (src) => {
        const names = [];
        let rx;
        try { rx = new RegExp(src, 'gi'); } catch { return names; }
        let m;
        while ((m = rx.exec(String(text))) !== null) {
            const name = String(m[1] || '').trim();
            if (name && !names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
            if (rx.lastIndex === m.index) rx.lastIndex++;
        }
        return names;
    };
    return { present: grab(onSrc), absent: grab(offSrc) };
}

// Pure: [IST: Name|kneeling, bloodied] carries the freshest visual state after the
// pipe — capture it (default marker shape only; custom patterns yield names only).
function markerDetails(text) {
    const out = {};
    const rx = /\[IST:\s*([^|\]]+)\|([^\]]*)\]/gi;
    let m;
    while ((m = rx.exec(String(text))) !== null) {
        const name = String(m[1] || '').trim();
        const detail = String(m[2] || '').replace(/\s+/g, ' ').trim();
        if (name && detail && !out[name.toLowerCase()]) out[name.toLowerCase()] = { name, detail };
    }
    return out;
}

// Pure: per-character current-state lines from a Summaryception-shaped ledger
// ({ name: { state } }). With an authoritative present-list, keys match by name
// (case-insensitive); without one, only characters the scene actually names.
function ledgerStateLines(ledger, presentNames, sceneLower) {
    if (!ledger || typeof ledger !== 'object') return [];
    const keys = Object.keys(ledger);
    const lines = [];
    const wanted = presentNames.length ? presentNames : keys;
    for (const name of wanted) {
        if (lines.length >= 6) break;
        const key = keys.find(k => k.toLowerCase() === String(name).toLowerCase());
        const entry = key ? ledger[key] : null;
        if (!entry || typeof entry.state !== 'string' || !entry.state.trim()) continue;
        if (!presentNames.length && sceneLower && !sceneLower.includes(String(name).toLowerCase())) continue;
        lines.push(`${key}: ${entry.state.replace(/\s+/g, ' ').trim().slice(0, 260)}`);
    }
    return lines;
}

function readPresencePatterns() {
    // Respect Summaryception's user-configured marker patterns when present.
    try {
        const sc = getContext().extensionSettings?.summaryception;
        return {
            on: (typeof sc?.ledgerPresenceOnPattern === 'string' && sc.ledgerPresenceOnPattern.trim()) ? sc.ledgerPresenceOnPattern : DEFAULT_PRESENCE_ON,
            off: (typeof sc?.ledgerPresenceOffPattern === 'string' && sc.ledgerPresenceOffPattern.trim()) ? sc.ledgerPresenceOffPattern : DEFAULT_PRESENCE_OFF,
        };
    } catch { return { on: DEFAULT_PRESENCE_ON, off: DEFAULT_PRESENCE_OFF }; }
}

// World-state + preceding-context grounding for the prompt builder. Sources, in
// authority order: presence markers from the newest message that prints them
// (walk-back window 6), Summaryception's per-character ledger state, and short
// tails of the two preceding turns for pronoun/place resolution. Every source
// degrades to nothing without error — grounding is fuel, never a dependency.
function collectSceneGrounding(mesId) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const targetText = String(chat[mesId]?.mes || '');
    const { on, off } = readPresencePatterns();

    let presence = { present: [], absent: [] };
    let details = {};
    for (let i = mesId; i >= 0 && i >= mesId - 6; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const found = scanPresenceIn(String(m.mes || ''), on, off);
        if (found.present.length) {
            presence = found;
            details = markerDetails(String(m.mes || ''));
            break;
        }
    }

    let ledger = null;
    try {
        const sc = ctx.chatMetadata?.summaryception;
        if (sc && sc.ledger && typeof sc.ledger === 'object') ledger = sc.ledger;
    } catch { /* not installed */ }
    const stateLines = ledgerStateLines(ledger, presence.present, targetText.toLowerCase());

    const charLines = [];
    const seen = new Set();
    for (const name of presence.present) {
        const d = details[name.toLowerCase()];
        const led = stateLines.find(l => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
        const bits = [];
        if (d) bits.push(d.detail);
        if (led) bits.push(led.slice(led.indexOf(':') + 1).trim());
        if (bits.length) {
            charLines.push(`${name}: ${bits.join(' — ')}`.slice(0, 320));
            seen.add(name.toLowerCase());
        }
    }
    for (const l of stateLines) {
        const nm = l.slice(0, l.indexOf(':')).toLowerCase();
        if (!seen.has(nm)) charLines.push(l);
    }

    const stateBlock = (presence.present.length || charLines.length)
        ? [
            'CURRENT WORLD STATE (authoritative ground truth):',
            presence.present.length ? `ON SCREEN: ${presence.present.join(', ')}` : '',
            presence.absent.length ? `OFF SCREEN (never depict): ${presence.absent.join(', ')}` : '',
            ...charLines,
        ].filter(Boolean).join('\n')
        : '';

    const tails = [];
    for (let i = mesId - 1; i >= 0 && tails.length < 2; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const text = stripScene(String(m.mes || '')).slice(-500).trim();
        if (text) tails.unshift(`[${m.is_user ? 'player' : 'story'}] ${text}`);
    }
    const contextBlock = tails.length
        ? `PRECEDING CONTEXT (reference only — resolve pronouns, place, time, outfits; never illustrate this):\n${tails.join('\n')}`
        : '';

    return { stateBlock, contextBlock, has: !!(stateBlock || contextBlock) };
}

async function getSceneText(mesId) {
    const ctx = getContext();
    const message = ctx.chat?.[mesId];
    if (!message) throw new Error(`Message #${mesId} not found`);
    let scene = stripScene(message.mes);
    const max = Math.max(1000, Number(settings.maxSceneChars) || 6000);
    if (scene.length > max) {
        // Keep the top (headers/trackers) and the tail (final beat of the scene).
        scene = scene.slice(0, Math.floor(max * 0.3)) + '\n[...trimmed...]\n' + scene.slice(-Math.floor(max * 0.7));
    }
    return scene;
}

async function buildScenePrompt(mesId) {
    const scene = await getSceneText(mesId);
    const style = resolveStyle();
    const system = style === 'tags' ? TAG_SYSTEM_PROMPT : NATURAL_SYSTEM_PROMPT;
    const sheet = getActiveCastSheet();
    const extra = String(settings.extraRules || '').trim();
    const grounding = collectSceneGrounding(mesId);
    const bubblesOn = !!settings.dialogueBubbles;

    const user = [
        sheet ? `CHARACTER SHEETS:\n${sheet}` : 'CHARACTER SHEETS: (none provided — infer appearances only from what the scene text explicitly states)',
        grounding.stateBlock,
        grounding.contextBlock,
        extra ? `EXTRA RULES:\n${extra}` : '',
        `SCENE (illustrate its final moment):\n${scene}`,
    ].filter(Boolean).join('\n\n');

    const maxPanels = Math.min(6, Math.max(1, Number(settings.maxPanels) || 1));
    const castEntryCount = parseCastSheet(getActiveCastSheet()).length;
    // Identity is code in EVERY mode: a single frame gets the same structured who
    // contract when a cast exists (tags style — the binding language). Before this,
    // single-frame identity was builder-written and the who-retry fired against a
    // schema that was never sent — one wasted, contradictory builder call per image.
    const structuredSingle = maxPanels === 1 && style === 'tags' && castEntryCount > 0;
    let fullSystem = system;
    if (settings.backend === 'novelai' && style === 'tags') {
        fullSystem += '\n\nTARGET MODEL: NovelAI Diffusion V4.5 — blend Danbooru tags with a few short natural phrases used as tags (e.g. "moonlit stone alley at night", "crowded arena under harsh sun"); count tags and sheet-verbatim appearance rules still apply.\n\n' + NAI_GUIDANCE;
    }
    if (settings.backend === 'nanogpt' && style === 'natural') {
        fullSystem += '\n\nTARGET MODEL: Qwen-Image class — an LLM-grade text encoder reading paragraph-level prose. Rich concrete sentences beat fragments; name positions and spatial relations explicitly in words; no danbooru tag piles, no emphasis braces.';
    }
    if (grounding.has) fullSystem += GROUNDING_RULE;
    fullSystem += NSFW_RULE;
    const bubbleSchema = bubblesOn ? ',"bubbles":[{"speaker":"<name>","text":"<verbatim quote>"}]' : '';
    if (maxPanels > 1) {
        fullSystem += `\n\n${PLAN_LAWS.replace('%MAX%', String(maxPanels))}\n\nSEQUENCE MODE (active):\nBuild a vertical comic strip: decide how many panels (2 to ${maxPanels}) the scene's climax needs — one panel per DISTINCT visual beat, chronological order, ending on the final beat. Never fewer than 2 panels: the reader asked for a strip. Every character repeats their FULL appearance tag set verbatim in every panel they appear in — never change outfits, hair, or colors between panels. Each panel prompt describes exactly ONE moment in ONE frame — never write layout words (comic, panel, panels, page, grid, multiple views).
${FRAME_LAWS}
STRIP RULES (sequence mode only):
- Panels are the SCENE's beats in strict chronological order, first key moment to last — and the climax action itself (the strike, the explosion, the reveal) MUST be one of the panels; a strip that skips its own climax is a failed strip.
- CONTINUITY: consecutive panels are one continuous moment in one place — carry the previous panel's consequences forward (smoke from a blast lingers in the next panel; wounds, debris, and damage persist; light and weather never change mid-scene). No panel may contradict a state an earlier panel established.
- A beat with three or more principals is SPLIT into consecutive panels (panels are unlimited; frames are not).
- ONE BEAT PER PANEL, and every panel a DIFFERENT beat. More beats than panels: drop the weakest, never merge two into one frame. One action stretched over two panels (a sword leaving its sheath, then that same sword held overhead) is one beat rendered twice — pick the stronger image and spend the freed panel on a beat nothing else covers.
- A two-person exchange may play as a shot/reverse-shot pair across two panels.
- Consecutive panels NEVER repeat the same framing+angle pair — vary the camera like a filmed scene.${bubblesOn ? '\n\n' + BUBBLE_RULES : ''}\nOUTPUT (replaces the single-line requirement above): strict JSON only — no reasoning, no commentary, no markdown. The "plan" array comes FIRST and the "panels" array renders it one for one: {"plan":[{"beat":"<one plain sentence>","follows":"<how this follows the previous panel; omit on panel 1>","between":"<what passes between them; required when who has two names>","who":["Exact Cast Name"]}],"setting":"<location/environment/population tags for this scene>","dress":"<what people of this world wear, as tags>","panels":[{"who":[{"name":"Exact Cast Name","state":"<THIS character's pose, expression, wounds, and action tags>"},{"name":"...","state":"..."}],"prompt":"<camera, lighting, atmosphere, shared effects, environment ONLY>","sentence":"<ONE plain-English sentence describing only how the characters are arranged toward each other and the space — spatial relations and interaction, no appearance words>"${bubbleSchema}}]}`;
    } else if (structuredSingle) {
        fullSystem += `\n\nSINGLE FRAME (active):\nDepict exactly ONE frozen frame: the scene's FINAL visual beat — the last thing a camera would see. Choose that beat's principals for "who" and fold everyone else into the crowd; never montage, never split the moment.
${FRAME_LAWS}${bubblesOn ? '\n\n' + BUBBLE_RULES : ''}\nOUTPUT (replaces the single-line requirement above): strict JSON only — no reasoning, no commentary, no markdown, exactly one panel: {"setting":"<location/environment/population tags for this scene>","dress":"<what people of this world wear, as tags>","panels":[{"who":[{"name":"Exact Cast Name","state":"<THIS character's pose, expression, wounds, and action tags>"},{"name":"...","state":"..."}],"prompt":"<camera, lighting, atmosphere, shared effects, environment ONLY>","sentence":"<ONE plain-English sentence describing only how the characters are arranged toward each other and the space — spatial relations and interaction, no appearance words>"${bubbleSchema}}]}`;
    } else if (bubblesOn) {
        fullSystem += `\n\n${BUBBLE_RULES}\nOUTPUT (replaces the single-line requirement above): strict JSON only — no reasoning, no commentary, no markdown, exactly one panel: {"panels":[{"prompt":"<one prompt following all rules above>"${bubbleSchema}}]}`;
    }

    const maxTokens = maxPanels > 1 ? Math.min(3600, 500 + 650 * maxPanels) : structuredSingle ? 1300 : (bubblesOn ? 1100 : 800);

    // Code counts the scene's beats from its prose; the builder renders ALL of them.
    const beatCount = maxPanels > 1 ? Math.min(maxPanels, Math.max(2, countSceneBeats(scene))) : 0;
    if (beatCount) {
        fullSystem += `\n\nCODE BEAT COUNT: the scene's prose contains exactly ${beatCount} distinct visual beats, counted from the text by code — this number is not negotiable, not a suggestion. Output EXACTLY ${beatCount} panels, one per beat, in scene order. Fewer is a failed strip.`;
    }

    // ---------------------------------------------------------------- code bubbles
//
// The builder treats bubbles as optional homework and skips it (field: silent
// strips from dialogue-drenched scenes, three versions of retries). So code reads
// the scene's quotes DIRECTLY — verbatim by construction — and fills every panel
// the builder left silent, in scene order. Builder bubbles stay first choice.

function extractSceneQuotes(scene) {
    const out = [];
    const rx = /"([^"\n]{2,140})"/g;
    let m;
    while ((m = rx.exec(String(scene || ''))) !== null) {
        const text = m[1].replace(/\s+/g, ' ').trim();
        if (text.length >= 2 && /[a-zA-Z]/.test(text)) out.push({ text, index: m.index });
    }
    return out;
}

function attributeSpeaker(scene, quoteIndex, castNames) {
    const before = String(scene || '').slice(Math.max(0, quoteIndex - 400), quoteIndex).toLowerCase();
    let best = '', bestIdx = -1;
    for (const name of (castNames || [])) {
        const parts = String(name).split(/\s+/).filter(p => p.length >= 3);
        for (const part of [name, ...parts]) {
            const idx = before.lastIndexOf(part.toLowerCase());
            if (idx > bestIdx) { bestIdx = idx; best = name; }
        }
    }
    return best;
}

// A prefix of a verified quote is still verbatim; a trimmed string checked against
// the scene is not the same guarantee. Same rule as sanitizeBubbles.
function capBubbleText(text) {
    let t = String(text || '').trim();
    if (t.length <= 110) return t;
    const win = t.slice(0, 110);
    const sentenceEnd = Math.max(win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
    if (sentenceEnd > 40) return win.slice(0, sentenceEnd + 1).trim();
    const at = win.slice(0, 104).lastIndexOf(' ');
    return (at > 40 ? win.slice(0, at) : win.slice(0, 104)).trim() + '…';
}

// The plan arrives in the SAME answer as the panels — no second round trip. It is
    // validated after parsing, and only a plan that fails validation costs an extra call.
    let plan = null;
    let planNotes = [];

    let raw;
    try {
        raw = await callLLM(fullSystem, user, maxTokens);
    } catch (firstErr) {
        console.warn('[SceneSnap] builder attempt 1 failed, retrying once:', firstErr);
        raw = await callLLM(fullSystem, user, maxTokens);
    }
    console.log('[SceneSnap] raw builder output:', String(raw).slice(0, 600));
    let panels = parsePanels(raw, style, maxPanels, { bubbles: bubblesOn, sceneText: scene, expectJson: structuredSingle });
    // Enforcement, not hope: a builder that ignores the who schema gets exactly one
    // corrective re-call. Whichever output covers more panels with who wins; the image
    // is never blocked on compliance.
    const schemaSent = maxPanels > 1 || structuredSingle;
    if (maxPanels > 1) {
        plan = parsePlan(raw, maxPanels);
        if (plan) {
            const castNames = parseCastSheet(getActiveCastSheet()).map(c => c.name);
            const wantsCrowd = framesCrowd(plan.setting) || framesCrowd(scene);
            const problems = validatePlan(plan, castNames, maxPanels, { crowd: wantsCrowd, beatCount });
            if (problems.length) {
                console.warn('[SceneSnap] plan rejected:', problems);
                planNotes = problems.slice();
                try {
                    const rawFix = await callLLM(`${fullSystem}\n\nYOUR PLAN WAS REJECTED:\n- ${problems.join('\n- ')}\nRe-output the complete corrected JSON now — plan AND panels.`, user, maxTokens);
                    const planFix = parsePlan(rawFix, maxPanels);
                    if (planFix) {
                        const fixProblems = validatePlan(planFix, castNames, maxPanels, { crowd: wantsCrowd, beatCount });
                        // A repair is accepted on fewer problems — OR on restoring the
                        // crowd frame outright. Strictly-fewer-only let a repair that
                        // fixed the MISSING CROWD PANEL die on an equal score, and the
                        // strip shipped without its eruption frame (field).
                        const crowdRestored = wantsCrowd
                            && plan.panels.some(p => (p.who || []).length === 0)
                            && !planFix.panels.some(p => (p.who || []).length === 0);
                        if (fixProblems.length < problems.length || (crowdRestored && fixProblems.length <= problems.length)) {
                            const panelsFix = parsePanels(rawFix, style, maxPanels, { bubbles: bubblesOn, sceneText: scene, expectJson: structuredSingle });
                            if (panelsFix.length) { plan = planFix; panels = panelsFix; raw = rawFix; }
                        }
                    }
                } catch (e) { console.warn('[SceneSnap] plan repair failed, keeping first output:', e); }
            }
            console.log('[SceneSnap] plan:', plan.panels.map((p, i) => `${i + 1}. [${(p.who || []).join(', ') || 'crowd'}] ${p.beat}`));
        }
    }

    const whoOmitted = ps => ps.reduce((n, p) => n + (p.whoDeclared ? 0 : 1), 0);
    if (panels.length && schemaSent && whoOmitted(panels) && castEntryCount) {
        console.warn('[SceneSnap] builder omitted the who field on', whoOmitted(panels), 'panel(s) — issuing one corrective retry');
        try {
            const raw2 = await callLLM(fullSystem + `\n\nPREVIOUS OUTPUT REJECTED: every panel MUST include the "who" array of EXACT cast-sheet names, and the "prompt" must contain ZERO appearance traits of named characters. Re-output the complete corrected JSON now.`, user, maxTokens);
            const panels2 = parsePanels(raw2, style, maxPanels, { bubbles: bubblesOn, sceneText: scene, expectJson: structuredSingle });
            if (panels2.length && whoOmitted(panels2) < whoOmitted(panels)) { panels = panels2; raw = raw2; }
        } catch (e) { console.warn('[SceneSnap] corrective retry failed, keeping first output:', e); }
    }
    // Explicit panels must NAME the anatomy — a sex act with zero genital tags is a
    // builder failure. Euphemisms count as acts: 'drives deep' and 'stays buried
    // inside her' escaped 0.29.0's narrow regex and shipped genital-free (field).
    if (panels.length && schemaSent && panels.some(panelLacksAnatomy)) {
        console.warn('[SceneSnap] explicit panel names no anatomy — issuing one corrective retry');
        try {
            const raw3 = await callLLM(fullSystem + `\n\nPREVIOUS OUTPUT REJECTED: a panel depicts a sex act but names no anatomy, or names the act only in euphemism. In explicit scenes the shared prompt MUST name the act by its danbooru term (vaginal sex, missionary, doggystyle...) and every character's "state" MUST carry their visible anatomy (breast class + nipples, penis/erection, pussy/vulva, anus when visible, fluids), with 'completely nude' per naked character. Re-output the complete corrected JSON now.`, user, maxTokens);
            const panels3 = parsePanels(raw3, style, maxPanels, { bubbles: bubblesOn, sceneText: scene, expectJson: structuredSingle });
            if (panels3.length && !panels3.some(panelLacksAnatomy)) { panels = panels3; raw = raw3; }
        } catch (e) { console.warn('[SceneSnap] anatomy corrective retry failed, keeping first output:', e); }
    }
    // A dialogue-heavy scene with ZERO bubbles is a builder failure — the verbatim
    // lines exist; empty arrays everywhere mean it didn't try (field: a scene of
    // screams shipped silent).
    const bubbleTotal = ps => ps.reduce((n, p) => n + (p.bubbles || []).length, 0);
    // A speech beat that ships silent is a dropped voice: the PLAN said the beat was
    // speech (screamed, whispered, threatened) and the panel has no bubble (field:
    // three bubbles across a six-panel scene of screams).
    const SPEECH_BEAT = /(?:shout|scream|cry|cries|whisper|moan|chant|calls?|says?|speak|bark|sob|threaten|gasps?|groan|hiss|beg)/i;
    const silentSpeechBeats = (ps, pl) => {
        if (!pl) return [];
        const out = [];
        for (let i = 0; i < Math.min(pl.panels.length, ps.length); i++) {
            if (SPEECH_BEAT.test(pl.panels[i].beat) && !(ps[i].bubbles || []).length) out.push(i + 1);
        }
        return out;
    };
    const silent = bubblesOn ? silentSpeechBeats(panels, plan) : [];
    if (bubblesOn && schemaSent && panels.length
        && (bubbleTotal(panels) < 2 || silent.length)
        && (scene.match(/"[^"]{2,}"/g) || []).length >= 2) {
        console.warn('[SceneSnap] speech beats shipped silent:', silent, '— one corrective retry');
        try {
            const silentNote = silent.length ? ` Panels ${silent.join(', ')} are speech beats with EMPTY bubbles fields — those lines exist in the scene; quote them.` : '';
            const raw4 = await callLLM(fullSystem + `\n\nPREVIOUS OUTPUT REJECTED: the scene is full of spoken lines and the strip left speech beats silent.${silentNote} EVERY speech-beat panel needs 1-2 VERBATIM spoken lines (moans, cries, spilled names count), copied exactly from the scene, spread in speaking order. Re-output the complete corrected JSON now.`, user, maxTokens);
            const panels4 = parsePanels(raw4, style, maxPanels, { bubbles: bubblesOn, sceneText: scene, expectJson: structuredSingle });
            if (panels4.length && bubbleTotal(panels4) > bubbleTotal(panels)) { panels = panels4; raw = raw4; }
        } catch (e) { console.warn('[SceneSnap] bubble corrective retry failed, keeping first output:', e); }
    }
    // Code backstop: quotes are extracted from the scene itself (verbatim by
    // construction) and distributed across the panels the builder left silent, in
    // scene order — no silent talkative strips, ever.
    if (bubblesOn) {
        const quotes = extractSceneQuotes(scene);
        if (quotes.length) {
            const used = new Set();
            for (const p of panels) for (const b of (p.bubbles || [])) used.add(normalizeForMatch(b.text));
            const fresh = quotes.filter(q => !used.has(normalizeForMatch(q.text)));
            const castNames = parseCastSheet(getActiveCastSheet()).map(c => c.name);
            let qi = 0;
            for (let i = 0; i < panels.length && qi < fresh.length; i++) {
                if ((panels[i].bubbles || []).length) continue;
                // Establishing frames have no speaker — a code bubble there is a
                // floating word on an empty hall (field: 'alone').
                if (!(panels[i].who || []).length) continue;
                if (!panels[i].bubbles) panels[i].bubbles = [];
                const remainingPanels = panels.length - i;
                const take = Math.min(2, Math.max(1, Math.ceil((fresh.length - qi) / remainingPanels)));
                for (let k = 0; k < take && qi < fresh.length; k++, qi++) {
                    panels[i].bubbles.push({ speaker: attributeSpeaker(scene, fresh[qi].index, castNames), text: capBubbleText(fresh[qi].text) });
                }
            }
        }
    }
    // World anchor: builder-derived, cast-mined as backstop. Stamped onto every panel by
    // the extension (appendAnchor) — per-panel drift to modern dress/architecture becomes
    // structurally impossible instead of being a memory test for the builder.
    if (plan) {
        if (plan.setting) panels.setting = stripTransientFromSetting(plan.setting);
        if (plan.dress) panels.dress = plan.dress;
    }
    const rawDress = filterRankGarments(panels.dress) || mineDressTags(getActiveCastSheet());
    // Role words ('soldiers', 'officers') summon modern armies in a traditional world,
    // and the anti-modern NEGATIVE cannot beat a repeated POSITIVE (field: green
    // modern uniforms behind a shihakusho crowd). Purged from setting/prompts/states;
    // the anchor's own population words name these people. antiModern judges the RAW
    // dress — the filtered one may legitimately be empty.
    const antiModernOn = !!antiModernNegative(rawDress);
    if (antiModernOn && panels.setting) panels.setting = purgeModernRoles(neutralizeRoleUniforms(panels.setting, rawDress));
    const dress = cleanWorldDress(stripPersonalGarments(rawDress, getActiveCastSheet()), antiModernOn);
    let activeSheet = getActiveCastSheet();
    // A who-name missing from the cast means a panel with NO subject tags at all —
    // an empty courtyard where a character should be (field bug). Seed the missing
    // names once, targeted, then assemble.
    {
        const missingAll = new Set();
        for (const p of panels) {
            for (const w of (p.who || [])) {
                const entry = parseCastSheet(activeSheet).find(c => c.name.toLowerCase() === String(w.name).toLowerCase());
                if (!entry || isPlaceholderTags(entry.tags)) missingAll.add(w.name);
            }
        }
        if (missingAll.size && settings.autoCast) {
            console.warn('[SceneSnap] who-names missing from cast — targeted seeding:', [...missingAll]);
            try { await autoBuildCast({ silent: true, requiredNames: [...missingAll] }); activeSheet = getActiveCastSheet(); } catch (e) { console.warn('[SceneSnap] targeted seeding failed:', e); }
        }
    }
    // The scene's own wardrobe tracker ('| nothing |' in the header) is the highest
    // clothing authority there is — it overrides cast sheets AND builder states.
    const sceneNude = /\|\s*(?:nothing|nude|naked)\s*(?:\||\])/i.test(scene);
    const anchorText = [panels.setting || '', dress].filter(Boolean).join(', ');
    // Anatomy the strip established anywhere must survive everywhere.
    const stripAnatomy = new Set();
    for (const p of panels) {
        for (const w of (p.who || [])) {
            const st = String(w?.state || '').toLowerCase();
            if (/\bnipples?\b/.test(st)) stripAnatomy.add('nipples');
            if (/\bpussy\b/.test(st)) stripAnatomy.add('pussy');
            if (/\bpenis\b/.test(st)) stripAnatomy.add('penis');
        }
    }
    for (const p of panels) {
        const crowdHere = framesCrowd(anchorText) || framesCrowd(p.prompt);
        p.crowd = crowdHere;
        p.explicit = sceneNude || EXPLICIT_STATE.test([p.prompt, p.sentence, ...(p.who || []).map(w => String(w?.state || ''))].join(' '));
        if (p.explicit) {
            for (const w of (p.who || [])) w.state = anatomyContinuity(String(w?.state || ''), stripAnatomy);
        }
        p.sentence = replaceNamesInSentence(p.sentence, activeSheet);
        if (!p.who || !p.who.length) {
            // An establishing frame: the crowd or the place IS the subject. It leads
            // with the crowd's own words — anchor population plus the prompt's
            // ACTION-bearing crowd tokens, forward — no synthetic headcount.
            const deduped = unifyStripLighting(dedupeAgainstAnchor(antiModernOn ? purgeModernRoles(scrubEchoedCounts(p.prompt)) : scrubEchoedCounts(p.prompt), anchorText), anchorText);
            const cx = crowdHere ? extractCrowdTokens(deduped) : { crowd: '', rest: deduped };
            const crowdTag = [crowdHere ? hoistCrowdTokens(anchorText, true) : '', cx.crowd].filter(Boolean).join(', ');
            p.prompt = enforceShotGrammar([crowdTag, cx.rest].filter(Boolean).join(', '));
            p.welded = false;
            continue;
        }
        const { principals, background } = splitPrincipals(p.who);
        if (background.length) console.warn('[SceneSnap] background figure(s) demoted out of who:', background.map(w => w.name));
        // Explicit panels make their principals NUDE BY DEFAULT (0.31.0). The scene's
        // OWN TRACKER outranks a builder that keeps clothes on: a header declaring
        // worn clothing 'nothing' (0.32.0, field) strips garment+condition tokens too
        // — the scene said naked; 'pushed open' is builder fan-fiction.
        const panelExplicit = p.explicit || /\b(?:nude|naked)\b/i.test([p.prompt, p.sentence, ...p.who.map(w => String(w?.state || ''))].join(' '));
        if (panelExplicit) {
            const clothesStayOn = st => String(st).split(',').some(tok => GARMENT_CONDITION.test(tok) && hasGarment(tok));
            for (const w of principals) {
                let st = String(w.state || '');
                if (sceneNude) st = st.split(',').map(t => t.trim()).filter(t => t && !(GARMENT_CONDITION.test(t) && hasGarment(t))).join(', ');
                if (!/\b(?:nude|naked)\b/i.test(st) && (sceneNude || !clothesStayOn(st))) st = [st.trim(), 'nude'].filter(Boolean).join(', ');
                w.state = st;
            }
        }
        if (antiModernOn) for (const w of principals) w.state = purgeModernRoles(String(w.state || ''));
        // 'under him' without a lying cue renders as cowgirl (field). Derive it.
        for (const w of principals) w.state = inferLyingFromPosition(String(w.state || ''));
        // Lighting smuggled in via STATE bypasses the sky-unifier, which only scrubs
        // the shared prompt (field: 'dramatic backlighting from pale sun' welded into
        // a block gave one panel its own sky).
        for (const w of principals) w.state = unifyStripLighting(String(w.state || ''), anchorText);
        const id = assembleIdentity(principals, activeSheet, { dress: firstGarmentTag(dress), worldDress: dress });
        if (id.missing.length) console.warn('[SceneSnap] panel "who" names still not in cast sheet:', id.missing);
        const bgTag = background.length ? backgroundFigureTag(background, activeSheet) : '';
        // Crowd tokens carrying ACTIONS hoist forward with the anchor's population.
        const deduped = unifyStripLighting(dedupeAgainstAnchor(antiModernOn ? purgeModernRoles(scrubEchoedCounts(p.prompt)) : scrubEchoedCounts(p.prompt), anchorText), anchorText);
        let crowdTag = '';
        let restPrompt = explicitFramingGuard(deduped, p.explicit, principals.length);
        if (p.crowd) {
            const cx = extractCrowdTokens(deduped);
            crowdTag = [hoistCrowdTokens(anchorText, true), cx.crowd].filter(Boolean).join(', ');
            restPrompt = cx.rest;
        }
        // Natural-language encoders (Qwen/Flux) read description, not danbooru
        // grammar: the '1boy, 1girl' count run is tag-model syntax and reads as
        // noise — the field run rendered a dog-tongued protagonist with the partner
        // teleported behind him. Identity blocks lead as plain description instead.
        // Explicit panels lead with the literal 'nsfw' tag (tags mode, user mandate).
        const nsfwTag = (p.explicit && style === 'tags') ? 'nsfw' : '';
        if (style === 'natural') {
            p.prompt = enforceShotGrammar([...id.blocks, bgTag, crowdTag, restPrompt].filter(Boolean).join(', '));
        } else {
            p.prompt = enforceShotGrammar([nsfwTag, id.counts, ...id.blocks, bgTag, crowdTag, restPrompt].filter(Boolean).join(', '));
        }
        // A lying subject never gets a from-below camera — the model stands them up.
        // The sentence carries lying cues states miss ('head thrown back into pillow').
        const lyingHere = principals.some(w => LYING_STATE.test(String(w.state || ''))) || LYING_STATE.test(p.sentence);
        if (lyingHere) {
            p.prompt = p.prompt.replace(/\bfrom below\b/i, 'from above');
        }
        // An explicit panel with one partner lying and the other above needs the
        // camera overhead: eye level from the side shows only the top partner's back
        // and hair — a white-haired man on top reads as a white blanket (field).
        if (p.explicit && lyingHere
            && principals.some(w => /\babove (?:her|him|them)\b/i.test(String(w.state || '')))) {
            p.prompt = p.prompt.replace(/\beye level\b/i, 'from above');
        }
        p.who = principals;
        // Identity welded by code — the seed no longer has to protect subject appearance.
        p.welded = id.blocks.length > 0;
    }
    return { panels, style, raw: String(raw), setting: panels.setting || '', dress, schemaSent, plan, planNotes };
}

// ------------------------------------------------------------------ backends

async function generateRunware(positive, negative, landscape, seed) {
    const key = String(settings.runwareKey || '').trim();
    const model = String(settings.runwareModel || '').trim();
    if (!key) throw new Error('Runware API key is not set (SceneSnap settings)');
    if (!model) throw new Error('Runware model AIR is not set — copy it from the model page sidebar on Civitai (e.g. civitai:XXXXXX@XXXXXXX)');
    const { width, height } = getSize(landscape);

    return new Promise((resolve, reject) => {
        let settled = false;
        const taskUUID = uuid();
        let ws;
        const timer = setTimeout(() => finish(reject, new Error('Runware timed out (120s)')), 120000);
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws?.close(); } catch { /* noop */ }
            fn(arg);
        };

        try { ws = new WebSocket('wss://ws-api.runware.ai/v1'); } catch (e) { return finish(reject, e); }
        ws.onerror = () => finish(reject, new Error('Runware WebSocket connection failed'));
        ws.onopen = () => ws.send(JSON.stringify([{ taskType: 'authentication', apiKey: key }]));
        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (Array.isArray(msg?.errors) && msg.errors.length) {
                const e = msg.errors[0];
                return finish(reject, new Error(`Runware: ${e?.message || e?.code || 'unknown error'}`));
            }
            for (const item of (msg?.data ?? [])) {
                if (item.taskType === 'authentication') {
                    const task = {
                        taskType: 'imageInference',
                        taskUUID,
                        positivePrompt: positive,
                        model,
                        width,
                        height,
                        steps: Math.max(1, Number(settings.runwareSteps) || 26),
                        CFGScale: Number(settings.runwareCfg) || 5,
                        clipSkip: 2,
                        numberResults: 1,
                        seed: Number.isInteger(seed) ? seed : undefined,
                        outputType: 'base64Data',
                        outputFormat: 'JPEG',
                    };
                    if (negative) task.negativePrompt = negative;
                    const scheduler = String(settings.runwareScheduler || '').trim();
                    if (scheduler) task.scheduler = scheduler;
                    ws.send(JSON.stringify([task]));
                } else if (item.taskType === 'imageInference' && item.taskUUID === taskUUID) {
                    if (item.imageBase64Data) return finish(resolve, { format: 'jpg', data: item.imageBase64Data });
                    if (item.imageURL) return finish(resolve, { format: 'jpg', data: item.imageURL, isUrl: true });
                }
            }
        };
    });
}

async function generateNovelAI(positive, negative, landscape, seed) {
    const { width, height } = getSize(landscape);
    const res = await fetch('/api/novelai/generate-image', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            prompt: positive,
            model: settings.naiModel,
            sampler: 'k_euler_ancestral',
            scheduler: 'karras',
            steps: Math.min(Math.max(1, Number(settings.naiSteps) || 28), 50),
            scale: Number(settings.naiScale) || 5,
            width,
            height,
            negative_prompt: negative,
            seed: Number.isInteger(seed) ? seed : -1,
            sm: false,
            sm_dyn: false,
            decrisper: false,
            // Variety boost exists to push outputs apart. A strip is one continuous
            // place across its panels, so it is switched off there and kept for singles.
            variety_boost: !landscape,
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isStaleSession(res.status, text)) throw new Error(STALE_SESSION_MSG);
        throw new Error(`NovelAI: ${text || res.status} (is your NovelAI key set under API Connections?)`);
    }
    return { format: 'png', data: await res.text() };
}

async function generatePollinations(positive, negative, landscape, seed) {
    const { width, height } = getSize(landscape);
    const res = await fetch('/api/sd/pollinations/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            prompt: positive,
            negative_prompt: negative,
            model: String(settings.pollModel || 'flux').trim(),
            width,
            height,
            enhance: false,
            seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 2 ** 31),
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isStaleSession(res.status, text)) throw new Error(STALE_SESSION_MSG);
        throw new Error(`Pollinations: ${text || res.status}`);
    }
    const data = await res.json();
    if (!data?.image) throw new Error('Pollinations returned no image');
    return { format: data?.format || 'jpg', data: data.image };
}

// A page left open across an ST server restart holds a dead session: ST's CSRF gate
// then rejects every API call with 403 + an HTML error page ("Invalid CSRF token").
// Verified against a live ST instance. One reload fixes it — say exactly that.
const STALE_SESSION_MSG = 'This page is older than the SillyTavern server (ST restarted since it loaded) — reload the page and try again.';

function isStaleSession(status, bodyText) {
    return status === 403 && /invalid csrf token/i.test(String(bodyText || ''));
}

// NanoGPT's OpenAI-compatible image route: one key, 200+ models (Qwen-Image, Flux,
// HiDream...). The route has NO negative-prompt field — Qwen/Flux-class models
// largely ignore negatives anyway, so nothing is fabricated. Seed is forwarded as a
// hint (reproducibility is model-dependent per the docs). Discovery of each model's
// capabilities (including the nsfw flag) lives at GET /api/v1/images/models.
async function generateNanogpt(positive, negative, landscape, seed) {
    const key = String(settings.nanogptKey || '').trim();
    const model = String(settings.nanogptModel || 'qwen-image').trim();
    if (!key) throw new Error('NanoGPT API key is not set (SceneSnap settings)');
    if (!model) throw new Error('NanoGPT model is not set — e.g. qwen-image, flux, hidream');
    const { width, height } = getSize(landscape);
    let res;
    try {
        res = await fetch('https://nano-gpt.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: positive,
                model,
                n: 1,
                size: `${width}x${height}`,
                response_format: 'b64_json',
                num_inference_steps: Math.max(1, Number(settings.nanogptSteps) || 30),
                guidance_scale: Number(settings.nanogptCfg) || 7.5,
                seed: Number.isInteger(seed) ? seed : undefined,
            }),
        });
    } catch (e) {
        throw new Error('NanoGPT request failed at browser level — if this repeats, the API host is refusing cross-origin browser calls (CORS), and this backend needs a proxy. ' + (e?.message || e));
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`NanoGPT: ${text || res.status} (check your API key and model id)`);
    }
    const data = await res.json().catch(() => null);
    const img = data?.data?.[0];
    if (img?.b64_json) return { format: 'png', data: img.b64_json };
    if (img?.url) return { format: 'png', data: img.url, isUrl: true };
    throw new Error('NanoGPT returned no image');
}

// Panels render in parallel: six sequential generations tripled the strip's wait
// for zero reason — the renders are independent. Concurrency 2 keeps NAI rate
// limits calm while halving wall-clock time.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function generateWithBackend(positive, negative, landscape, seed) {
    switch (settings.backend) {
        case 'runware': return generateRunware(positive, negative, landscape, seed);
        case 'novelai': return generateNovelAI(positive, negative, landscape, seed);
        case 'nanogpt': return generateNanogpt(positive, negative, landscape, seed);
        default: return generatePollinations(positive, negative, landscape, seed);
    }
}

async function stitchPanels(base64List, format) {
    const mime = format === 'png' ? 'png' : 'jpeg';
    const imgs = await Promise.all(base64List.map(b64 => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('A panel image failed to load for stitching'));
        img.src = `data:image/${mime};base64,${b64}`;
    })));
    // Vertical webtoon stack: reads top-to-bottom, mobile-native, works for any panel count.
    // Rigid comic grid: every panel cover-fills an identical cell (first panel's dims are
    // the contract), thin gutters, black frame per cell — the printed-strip look. Cover-crop
    // makes it impossible for a stray odd-sized panel to break the grid.
    const gutter = 10;
    const cellW = imgs[0].width;
    const cellH = imgs[0].height;
    const canvas = document.createElement('canvas');
    canvas.width = cellW + gutter * 2;
    canvas.height = cellH * imgs.length + gutter * (imgs.length + 1);
    const cx = canvas.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, canvas.width, canvas.height);
    let y = gutter;
    for (const img2 of imgs) {
        const scale = Math.max(cellW / img2.width, cellH / img2.height);
        const sw = cellW / scale;
        const sh = cellH / scale;
        const sx = (img2.width - sw) / 2;
        const sy = (img2.height - sh) / 2;
        cx.drawImage(img2, sx, sy, sw, sh, gutter, y, cellW, cellH);
        cx.lineWidth = 4;
        cx.strokeStyle = '#101010';
        cx.strokeRect(gutter + 2, y + 2, cellW - 4, cellH - 4);
        y += cellH + gutter;
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('Comic strip stitching failed');
    const dataUrl = await getBase64Async(blob);
    return String(dataUrl).split(',')[1];
}

// ------------------------------------------------------------------ dialogue bubbles

function pathRoundRect(cx, x, y, w, h, r) {
    if (typeof cx.roundRect === 'function') { cx.roundRect(x, y, w, h, r); return; }
    const rr = Math.min(r, w / 2, h / 2);
    cx.moveTo(x + rr, y);
    cx.arcTo(x + w, y, x + w, y + h, rr);
    cx.arcTo(x + w, y + h, x, y + h, rr);
    cx.arcTo(x, y + h, x, y, rr);
    cx.arcTo(x, y, x + w, y, rr);
    cx.closePath();
}

// Draw the panel's dialogue as manhwa-style floating bubbles. SceneSnap renders
// the text itself, so it is pixel-legible on EVERY backend and can never come out
// model-garbled. First bubble top-left, second top-right, in speech order.
// Failure here must never cost the image — callers catch and ship the clean panel.
async function overlayBubbles(b64, format, bubbles) {
    if (!Array.isArray(bubbles) || !bubbles.length) return b64;
    const mime = format === 'png' ? 'png' : 'jpeg';
    const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('Bubble overlay: panel image failed to load'));
        i.src = `data:image/${mime};base64,${b64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const cx = canvas.getContext('2d');
    cx.drawImage(img, 0, 0);
    const W = img.width;
    const fontPx = Math.round(Math.min(40, Math.max(17, W / 24)));
    cx.font = `700 ${fontPx}px "Comic Neue", "Comic Sans MS", sans-serif`;
    cx.textBaseline = 'top';
    const twoUp = Math.min(2, bubbles.length) > 1;
    const maxTextW = twoUp ? W * 0.36 : W * 0.58;
    const yBase = Math.round(img.height * 0.035);
    for (let i = 0; i < Math.min(2, bubbles.length); i++) {
        const words = String(bubbles[i].text).split(' ');
        const lines = [];
        let line = '';
        for (const word of words) {
            const probe = line ? `${line} ${word}` : word;
            if (line && cx.measureText(probe).width > maxTextW) { lines.push(line); line = word; }
            else line = probe;
        }
        if (line) lines.push(line);
        const textW = Math.max(...lines.map(l => cx.measureText(l).width));
        const lineH = Math.round(fontPx * 1.25);
        const padX = Math.round(fontPx * 0.9);
        const padY = Math.round(fontPx * 0.62);
        const bw = Math.min(textW + padX * 2, W * 0.92);
        const bh = lines.length * lineH + padY * 2;
        const x = i % 2 === 0 ? Math.round(W * 0.04) : Math.max(Math.round(W * 0.04), Math.round(W * 0.96 - bw));
        const y = yBase + (i === 1 ? Math.round(fontPx * 0.35) : 0);
        cx.beginPath();
        pathRoundRect(cx, x, y, bw, bh, fontPx * 1.1);
        cx.fillStyle = 'rgba(255,255,255,0.96)';
        cx.fill();
        cx.lineWidth = Math.max(2, Math.round(fontPx / 9));
        cx.strokeStyle = '#101010';
        cx.stroke();
        cx.fillStyle = '#101010';
        for (let li = 0; li < lines.length; li++) {
            cx.fillText(lines[li], x + padX + (textW - cx.measureText(lines[li]).width) / 2, y + padY + li * lineH);
        }
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, `image/${mime}`, 0.94));
    if (!blob) throw new Error('Bubble overlay failed to encode');
    const dataUrl = await getBase64Async(blob);
    return String(dataUrl).split(',')[1];
}

// ------------------------------------------------------------------ core flow

function setButtonBusy(mesId, busy) {
    const $btn = $(`#chat .mes[mesid="${mesId}"] .snapshot_mes_btn`);
    $btn.toggleClass('fa-panorama', !busy).toggleClass('fa-hourglass fa-fade', busy);
}

async function illustrateMessage(mesId, { force = false } = {}) {
    mesId = Number(mesId);
    if (!settings.enabled && !force) return;

    const ctx = getContext();
    const message = ctx.chat?.[mesId];
    if (!message || message.is_user || message.is_system) {
        if (force) toastr.warning('That message cannot be illustrated', 'SceneSnap');
        return;
    }
    if (inFlight.has(mesId)) {
        if (force) toastr.info('Already generating for this message', 'SceneSnap');
        return;
    }

    inFlight.add(mesId);
    setButtonBusy(mesId, true);

    try {
        if (settings.autoCast) {
            // Every chat seeds its own NEW characters once — append-only: existing lines
            // are never touched (the builder skips them and mergeCastLines keeps them).
            // Refreshing a wrong entry = delete that one line; the next chat re-seeds it.
            const ctx0 = getContext();
            const bootKey = `${ctx0.chatId ?? 'chat'}:${getActiveCastName()}`;
            if (!castBootstrapAttempted.has(bootKey)) {
                castBootstrapAttempted.add(bootKey);
                await autoBuildCast({ silent: true });
            }
        }
        if (!parseCastSheet(getActiveCastSheet()).length) {
            // Sheetless generation loses appearance locking — a sheet of malformed lines
            // is as sheetless as an empty one. Degrade loudly, once per chat.
            const chatKey = String(getContext().chatId ?? 'chat');
            if (!sheetWarned.has(chatKey)) {
                sheetWarned.add(chatKey);
                toastr.info('No cast sheet — character appearances may drift between images. SceneSnap settings → Auto-build cast.', 'SceneSnap', { timeOut: 9000 });
            }
        }

        // A tag-style prompt on a natural-language model is tag noise (field: Qwen
        // given '1boy, 1girl' tag piles returned a dog-tongued protagonist).
        if (settings.backend === 'nanogpt' && resolveStyle() === 'tags') {
            const wk = `nanogpt-tags:${getContext().chatId ?? 'chat'}`;
            if (!sheetWarned.has(wk)) {
                sheetWarned.add(wk);
                toastr.warning('Qwen-Image reads natural language — Prompt style: tags is hurting accuracy. Set Prompt style to Auto or Natural.', 'SceneSnap', { timeOut: 10000 });
            }
        }
        const negative = effectiveNegative();
        let panelImages = [];
        let panelFormat = 'png';
        let positive = '';
        let debugRaw = '';
        let debugPrompts = [];


            const { panels, style, raw, setting, dress, schemaSent, plan, planNotes } = await buildScenePrompt(mesId);
            // V4.5 Curated is trained on filtered data and suppresses explicit
            // anatomy. An explicit panel on Curated is a silent NSFW kill — warn
            // once per chat instead of letting the user debug a blank.
            if (settings.backend === 'novelai' && /curated/i.test(String(settings.naiModel || ''))
                && panels.some(p => (p.who || []).some(w => EXPLICIT_STATE.test(String(w?.state || ''))))) {
                const curKey = `curated:${getContext().chatId ?? 'chat'}`;
                if (!sheetWarned.has(curKey)) {
                    sheetWarned.add(curKey);
                    toastr.warning('Explicit scene on NAI V4.5 Curated — Curated suppresses nipples/genitals by training. Switch SceneSnap’s NovelAI model to V4.5 Full for NSFW.', 'SceneSnap', { timeOut: 12000 });
                }
            }
            // The setting already names the population and what it wears, by law, in its
            // own words ("packed courtyard of shinigami in black shihakusho"). A second
            // bound phrase repeating that garment only flattened the crowd into one mass.
            const anchorFor = (p) => [setting, dressForPanel(dress, p?.explicit)].filter(Boolean).join(', ');
            const negFull = antiModernNegative(dress) ? `${negative}, ${antiModernNegative(dress)}` : negative;
            // Hybrid prompting: tags own identity/state (binding); NAI 4.5-class models also
            // read short natural sentences well, and sentences beat tags at spatial relations —
            // so one composition sentence rides at the end, tags mode only.
            const finals = panels.map(p => composePositive(
                // The composition sentence rides EVERY style — on natural-language
                // models (Qwen) it is the strongest spatial binder there is, and it
                // was being thrown away exactly where it mattered most (field).
                p.sentence ? `${appendAnchor(p.prompt, anchorFor(p))}, ${p.sentence}` : appendAnchor(p.prompt, anchorFor(p)),
                style,
            ));
            debugRaw = raw;
            debugPrompts = finals.slice();
            {
                const castEntries = parseCastSheet(getActiveCastSheet());
                debugPrompts.unshift(
                    `ENGINE v${VERSION}`,
                    plan ? `PLAN — ${plan.panels.map((p, i) => `${i + 1}. [${(p.who || []).join(', ') || 'crowd'}] ${p.beat}`).join('  |  ')}${planNotes.length ? `\n  (repaired: ${planNotes.join(' ')})` : ''}` : 'PLAN — (single-call builder; no plan pass)',
                    `CAST — "${getActiveCastName()}": ${castEntries.length} entr${castEntries.length === 1 ? 'y' : 'ies'}${castEntries[0] ? ` (first: ${castEntries[0].name}: ${castEntries[0].tags.slice(0, 60)})` : ''}`,
                );
            }
            panels.forEach((p, i) => debugPrompts.push(`PANEL ${i + 1} WHO — ${p.who && p.who.length ? p.who.map(w => w.state ? `${w.name} [${w.state}]` : w.name).join(' | ') : (p.whoDeclared ? '(establishing frame — crowd is the subject)' : schemaSent ? '(builder omitted the who field)' : '(single frame — builder-written identity)')}`));
            panels.forEach((p, i) => p.bubbles.forEach(b => debugPrompts.push(`PANEL ${i + 1} BUBBLE — ${b.speaker || '?'}: "${b.text}"`)));
            console.log(`[SceneSnap] ${finals.length} panel(s) (${style}):`, finals);
            // One seed for the whole strip: same character rendering in every panel.
            // Panels render in PARALLEL (concurrency 2) — sequential was the slowdown.
            const runSeed = Math.floor(Math.random() * 2 ** 31);
            panelImages = await mapLimit(panels, 2, async (p, i) => {
                const result = await generateWithBackend(finals[i], negFull, panels.length > 1, seedForPanel(runSeed, (p.who || []).map(w => w.name), p.welded));
                const fmt = result.format || panelFormat;
                panelFormat = fmt;
                let imageB64 = result.isUrl ? await urlToBase64(result.data) : result.data;
                if (p.bubbles.length) {
                    try { imageB64 = await overlayBubbles(imageB64, fmt, p.bubbles); }
                    catch (e) { console.warn('[SceneSnap] bubble overlay failed, shipping the clean panel:', e); }
                }
                return imageB64;
            });
        positive = finals.join('  \u25ba  ');


        lastDebug = { time: new Date().toLocaleTimeString(), engine: VERSION, backend: settings.backend, style: resolveStyle(), raw: debugRaw, prompts: debugPrompts, negative, error: null };

        const base64 = panelImages.length > 1
            ? await stitchPanels(panelImages, panelFormat)
            : panelImages[0];
        const outputFormat = panelImages.length > 1 ? 'jpg' : panelFormat;

        // Re-fetch context: chat may have advanced while we generated.
        const ctx2 = getContext();
        const msg = ctx2.chat?.[mesId];
        if (!msg) throw new Error('Message no longer exists (chat changed?)');

        const subFolder = String(ctx2.name2 || 'SceneSnap');
        const fileName = `snap_${mesId}_${Date.now()}`;
        const url = await saveBase64AsFile(base64, subFolder, fileName, outputFormat);

        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        if (!Array.isArray(msg.extra.media)) msg.extra.media = [];
        if (!msg.extra.media.length && !msg.extra.media_display) msg.extra.media_display = 'gallery';
        msg.extra.inline_image = !(msg.extra.media.length && !msg.extra.inline_image);
        msg.extra.media.push({
            url,
            type: 'image',
            title: positive,
            negative,
            source: 'generated',
            scenesnap: true,
        });
        msg.extra.media_index = msg.extra.media.length - 1;

        const $mes = $(`#chat .mes[mesid="${mesId}"]`);
        if ($mes.length) { appendMediaToMessage(msg, $mes, 'keep'); $mes.addClass('scenesnap-media'); }
        await ctx2.saveChat();
    } catch (err) {
        const msg = explainError(err?.message || err);
        if (lastDebug) lastDebug.error = msg;
        else lastDebug = { time: new Date().toLocaleTimeString(), engine: VERSION, backend: settings.backend, style: resolveStyle(), raw: '(builder did not run)', prompts: [], negative: effectiveNegative(), error: msg };
        notifyError(err);
    } finally {
        inFlight.delete(mesId);
        setButtonBusy(mesId, false);
    }
}

// ------------------------------------------------------------------ auto mode + message buttons

function addMessageButton(mesId) {
    const $mes = $(`#chat .mes[mesid="${mesId}"]`);
    if (!$mes.length || $mes.attr('is_user') === 'true' || $mes.attr('is_system') === 'true') return;
    const $container = $mes.find('.extraMesButtons');
    if (!$container.length || $container.find('.snapshot_mes_btn').length) return;
    $container.prepend('<div title="SceneSnap: illustrate this scene" class="mes_button snapshot_mes_btn fa-solid fa-panorama interactable" tabindex="0"></div>');
}

function addAllMessageButtons() {
    $('#chat .mes').each(function () {
        addMessageButton($(this).attr('mesid'));
    });
}

function onCharacterMessageRendered(mesId) {
    addMessageButton(mesId);

    if (!settings.enabled || !settings.auto) return;
    if (Date.now() < suppressAutoUntil) return;

    const ctx = getContext();
    mesId = Number(mesId);
    if (mesId !== (ctx.chat?.length ?? 0) - 1) return;

    const message = ctx.chat?.[mesId];
    if (!message || message.is_user || message.is_system) return;

    const key = `${ctx.chatId ?? 'chat'}:${mesId}:${message.swipe_id ?? 0}`;
    if (autoDone.has(key)) return;
    autoDone.add(key);

    setTimeout(() => illustrateMessage(mesId), 100);
}

// Full-bleed comics survive reloads: any message whose media list contains a SceneSnap
// image gets the class that lifts ST's 40vh thumbnail cap (see style.css).
function markSceneSnapMedia() {
    try {
        const ctx = getContext();
        (ctx.chat || []).forEach((m, i) => {
            if (m?.extra?.media?.some(x => x?.scenesnap)) $(`#chat .mes[mesid="${i}"]`).addClass('scenesnap-media');
        });
    } catch { /* cosmetic only */ }
}

function onChatChanged() {
    suppressAutoUntil = Date.now() + 2500;
    autoDone.clear();
    setTimeout(() => {
        addAllMessageButtons();
        refreshCastUI();
        markSceneSnapMedia();
    }, 500);
}

// ------------------------------------------------------------------ story memory probes

/**
 * Gathers long-term story memory from known memory extensions, gracefully
 * skipping anything that is not installed. Currently probed:
 * - Summaryception (and personal forks): chatMetadata.summaryception -> notepad + layered snippets
 * - Author's Note: chatMetadata.note_prompt (often carries plot-essential canon)
 * - ST built-in Summarize: chatMetadata.memory
 */
function collectStoryMemory() {
    const ctx = getContext();
    const md = ctx.chatMetadata || {};
    const parts = [];

    try {
        const sc = md.summaryception;
        if (sc && typeof sc === 'object') {
            if (typeof sc.notepad === 'string' && sc.notepad.trim()) {
                parts.push(`[CANON NOTEPAD]\n${sc.notepad.trim()}`);
            }
            if (Array.isArray(sc.layers)) {
                const snippets = [];
                for (let i = sc.layers.length - 1; i >= 0; i--) { // deepest layer first
                    for (const sn of (Array.isArray(sc.layers[i]) ? sc.layers[i] : [])) {
                        const text = typeof sn === 'string' ? sn : sn?.text;
                        if (!text) continue;
                        const detail = (sn && typeof sn === 'object' && sn.detail) ? ` | detail: ${sn.detail}` : '';
                        snippets.push(`- ${String(text).trim()}${detail}`);
                    }
                }
                if (snippets.length) parts.push(`[STORY SUMMARY SNIPPETS]\n${snippets.join('\n')}`);
            }
        }
    } catch (e) {
        console.warn('[SceneSnap] Summaryception probe failed', e);
    }

    if (typeof md.note_prompt === 'string' && md.note_prompt.trim()) {
        parts.push(`[AUTHOR'S NOTE]\n${md.note_prompt.trim()}`);
    }
    if (typeof md.memory === 'string' && md.memory.trim()) {
        parts.push(`[SUMMARY]\n${md.memory.trim()}`);
    }

    return parts.join('\n\n');
}

function mergeCastLines(existing, incoming) {
    const seen = new Set();
    const out = [];
    for (const raw of `${existing}\n${incoming}`.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const name = line.split(':')[0].trim().toLowerCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(line);
    }
    return out.join('\n');
}

const castBootstrapAttempted = new Set();
const sheetWarned = new Set();

// ------------------------------------------------------------------ cast auto-build

// Canon Grounding (sibling extension) caches wiki-extracted per-character facts at
// chatMetadata.canon_grounding_cache — entries { found, name, aliases, sections: { physical } }.
// sections.physical is the fandom wiki's APPEARANCE text: the authoritative automatic
// source for canon characters the prose never re-describes. Read-only, fully guarded.
function collectCanonWikiAppearances() {
    try {
        const cacheObj = getContext().chatMetadata?.canon_grounding_cache;
        if (!cacheObj || typeof cacheObj !== 'object') return '';
        const lines = [];
        for (const [key, e] of Object.entries(cacheObj)) {
            const physical = e?.found && e?.sections?.physical;
            if (!physical) continue;
            lines.push(`${e.name || key}: ${String(physical).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
            if (lines.join('\n').length > 4000) break;
        }
        return lines.join('\n');
    } catch (e) { return ''; }
}

async function autoBuildCast({ silent = false, requiredNames = [] } = {}) {
    const ctx = getContext();
    const memory = collectStoryMemory().slice(0, 14000);
    const excerpt = (ctx.chat || [])
        .filter(m => m && !m.is_system)
        .slice(-12)
        .map(m => `${m.name}: ${String(m.mes || '').slice(0, 1200)}`)
        .join('\n\n');
    if (!excerpt && !memory) {
        if (!silent) toastr.warning('No story memory and no chat to scan', 'SceneSnap');
        return false;
    }

    const $btn = $('#snapshot_cast_build');
    $btn.addClass('disabled');
    try {
        const user = [
            `PLAYER CHARACTER HINT: the human player's persona is named "${ctx.name1 || 'User'}" — the protagonist may appear under this or another in-story name; include the protagonist either way.`,
            requiredNames.length ? `REQUIRED CHARACTERS (output a line for EACH of these): ${requiredNames.join(', ')}` : '',
            (() => { const w = collectCanonWikiAppearances(); return w ? `CANON WIKI DATA (authoritative appearances from the fandom wiki — convert faithfully into danbooru tags):\n${w}` : ''; })(),
            `EXISTING SHEET (skip these characters):\n${stripPlaceholderLines(getActiveCastSheet()) || '(empty)'}`,
            memory ? `STORY MEMORY:\n${memory}` : '',
            excerpt ? `RECENT CHAT EXCERPT:\n${excerpt}` : '',
        ].filter(Boolean).join('\n\n');
        const raw = await callLLM(CAST_SYSTEM_PROMPT, user, 900);
        const cleaned = String(raw)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^[^:]{1,40}:\s?.+/.test(l) && !/^(existing|chat|sheet|example|name)\b/i.test(l))
            .join('\n');
        if (!cleaned || /^NONE$/i.test(cleaned.trim())) {
            if (!silent) toastr.info('No new characters found', 'SceneSnap');
            return false;
        }
        const cast = getActiveCastName();
        settings.casts[cast] = mergeCastLines(stripPlaceholderLines(String(settings.casts[cast] || '')), cleaned);
        saveSettingsDebounced();
        $('#snapshot_cast_sheet').val(settings.casts[cast]);
        toastr.success(silent ? 'Cast sheet auto-built from story memory — review it in settings' : 'Cast sheet updated — review and edit it', 'SceneSnap');
        return true;
    } catch (err) {
        if (silent) {
            console.warn('[SceneSnap] cast bootstrap failed, continuing without a sheet', err);
            return false;
        }
        notifyError(err);
        return false;
    } finally {
        $btn.removeClass('disabled');
    }
}

// ------------------------------------------------------------------ settings UI

function settingsHtml() {
    return `
    <div id="snapshot_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SceneSnap (Scene Illustrator)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="snapshot_enabled" type="checkbox"><span>Enabled</span></label>
                <small class="snapshot_hint">Master switch for all SceneSnap features.</small>
                <label class="checkbox_label"><input id="snapshot_auto" type="checkbox"><span>Auto-illustrate new AI messages</span></label>
                <small class="snapshot_hint">Generates an image for every new AI reply. Runs after the text renders — never delays or blocks generation.</small>
                <label class="checkbox_label"><input id="snapshot_autocast" type="checkbox"><span>Auto-build cast when empty</span></label>
                <small class="snapshot_hint">If the active cast sheet is empty, the first illustration in a chat builds it automatically from story memory before generating. Continues without a sheet if that fails.</small>

                <label for="snapshot_backend">Image backend</label>
                <select id="snapshot_backend" class="text_pole">
                    <option value="pollinations">Pollinations (free, natural-language)</option>
                    <option value="runware">Runware (Civitai anime checkpoints, tags)</option>
                    <option value="novelai">NovelAI (uses ST NovelAI key, tags)</option>
                    <option value="nanogpt">NanoGPT (Qwen-Image, Flux &amp; 200+ models, natural-language)</option>
                </select>
                <small class="snapshot_hint">Which service renders the image. Pollinations = free zero-setup test rig. Runware = any Civitai anime checkpoint, fast + near-free (recommended). NovelAI = strongest anime model, needs your NAI key in API Connections.</small>

                <div id="snapshot_runware_block" class="snapshot_backend_block">
                    <label for="snapshot_runware_key">Runware API key</label>
                    <input id="snapshot_runware_key" type="password" class="text_pole" placeholder="rw-..." autocomplete="off">
                    <small class="snapshot_hint">From runware.ai dashboard → API Keys.</small>
                    <label for="snapshot_runware_model">Model (AIR from Civitai sidebar)</label>
                    <input id="snapshot_runware_model" type="text" class="text_pole" placeholder="civitai:XXXXXX@XXXXXXX">
                    <small class="snapshot_hint">Which checkpoint to run — copy the AIR ID from the model page's right sidebar on civitai.com. Any Illustrious XL / NoobAI-XL merge works great.</small>
                    <div class="flex-container">
                        <div class="flex1"><label for="snapshot_runware_steps">Steps</label><input id="snapshot_runware_steps" type="number" min="1" max="60" class="text_pole"></div>
                        <div class="flex1"><label for="snapshot_runware_cfg">CFG</label><input id="snapshot_runware_cfg" type="number" min="1" max="15" step="0.5" class="text_pole"></div>
                    </div>
                    <small class="snapshot_hint">Steps: detail vs speed, 20–30 is the sweet spot. CFG: prompt strictness, 3–6 for anime checkpoints — higher fries colors.</small>
                    <label for="snapshot_runware_scheduler">Scheduler (blank = model default)</label>
                    <input id="snapshot_runware_scheduler" type="text" class="text_pole" placeholder="e.g. Euler a">
                    <small class="snapshot_hint">Sampling method. Leave blank unless the checkpoint page recommends one (usually Euler a).</small>
                </div>

                <div id="snapshot_novelai_block" class="snapshot_backend_block">
                    <label for="snapshot_nai_model">NovelAI model</label>
                    <select id="snapshot_nai_model" class="text_pole">
                        <option value="nai-diffusion-4-5-full">NAI Diffusion V4.5 Full</option>
                        <option value="nai-diffusion-4-5-curated">NAI Diffusion V4.5 Curated</option>
                        <option value="nai-diffusion-3">NAI Diffusion V3</option>
                    </select>
                    <small class="snapshot_hint">V4.5 Full = strongest, best multi-character. Curated = cleaner training data.</small>
                    <div class="flex-container">
                        <div class="flex1"><label for="snapshot_nai_steps">Steps (≤50)</label><input id="snapshot_nai_steps" type="number" min="1" max="50" class="text_pole"></div>
                        <div class="flex1"><label for="snapshot_nai_scale">Scale</label><input id="snapshot_nai_scale" type="number" min="1" max="10" step="0.5" class="text_pole"></div>
                    </div>
                    <small class="snapshot_hint">Steps: 28 on free Opus (the free-gen limit), 35–40 on paid tiers — more steps = cleaner hands/anatomy. Scale = prompt adherence, 5 default, 6 for stubborn positions.</small>
                </div>

                <div id="snapshot_nanogpt_block" class="snapshot_backend_block">
                    <label for="snapshot_nanogpt_key">NanoGPT API key</label>
                    <input id="snapshot_nanogpt_key" type="password" class="text_pole" placeholder="sk-..." autocomplete="off">
                    <small class="snapshot_hint">From nano-gpt.com dashboard. One key, 200+ models.</small>
                    <label for="snapshot_nanogpt_model">Model id</label>
                    <input id="snapshot_nanogpt_model" type="text" class="text_pole" placeholder="qwen-image">
                    <small class="snapshot_hint">Qwen-Image reads natural-language paragraphs (set Prompt style: Auto). List models + their nsfw flag: GET nano-gpt.com/api/v1/images/models — explicit scenes need a model with nsfw: true.</small>
                    <div class="flex-container">
                        <div class="flex1"><label for="snapshot_nanogpt_steps">Steps</label><input id="snapshot_nanogpt_steps" type="number" min="1" max="100" class="text_pole"></div>
                        <div class="flex1"><label for="snapshot_nanogpt_cfg">Guidance</label><input id="snapshot_nanogpt_cfg" type="number" min="0" max="20" step="0.5" class="text_pole"></div>
                    </div>
                    <small class="snapshot_hint">Steps 20–40 is the sweet spot. Guidance: prompt adherence, ~7.5 default; lower for softer interpretation.</small>
                </div>

                <div id="snapshot_pollinations_block" class="snapshot_backend_block">
                    <label for="snapshot_poll_model">Pollinations model</label>
                    <input id="snapshot_poll_model" type="text" class="text_pole" placeholder="flux">
                    <small class="snapshot_hint">"flux" = default free model. "turbo" = faster, lower quality.</small>
                </div>

                <label for="snapshot_size">Image size</label>
                <select id="snapshot_size" class="text_pole">
                    <option value="portrait">Portrait 832×1216</option>
                    <option value="landscape">Landscape 1216×832</option>
                    <option value="wide">Wide 1344×768</option>
                    <option value="square">Square 1024×1024</option>
                </select>
                <small class="snapshot_hint">Portrait is the anime standard; Landscape/Wide suit big environmental shots with crowds. All presets stay inside NovelAI's free-gen budget.</small>

                <label for="snapshot_panels">Max panels (comic sequence)</label>
                <input id="snapshot_panels" type="number" min="1" max="6" class="text_pole">
                <small class="snapshot_hint">1 = single frame. 2–6 = a guaranteed strip — the builder picks at least 2 panels, up to your cap, stitched top-to-bottom (webtoon style). Each panel is a full generation — free on NAI Opus, pennies on Runware, but N× the wait. The console logs how many panels the builder chose.</small>

                <label class="checkbox_label"><input id="snapshot_bubbles" type="checkbox"><span>Dialogue bubbles (comic text)</span></label>
                <small class="snapshot_hint">Draws up to two speech bubbles per panel with dialogue copied verbatim from the scene. SceneSnap renders the text itself — always legible on every backend, never model-garbled. Lines that aren't found word-for-word in the scene are dropped, never invented. Pair with Max panels 2–4 for the full manhwa-strip look.</small>

                <hr>
                <label for="snapshot_profile">Prompt builder LLM (Connection Manager profile)</label>
                <select id="snapshot_profile" class="text_pole"></select>
                <small class="snapshot_hint">The text model that converts the scene into an image prompt. Pick a FAST profile — this decides most of your image latency. Main API fallback works but sends your whole chat context (slow on big stories).</small>
                <label for="snapshot_style">Prompt style</label>
                <select id="snapshot_style" class="text_pole">
                    <option value="auto">Auto (match backend)</option>
                    <option value="tags">NovelAI (danbooru tags)</option>
                    <option value="natural">Natural language (Qwen, FLUX)</option>
                </select>
                <small class="snapshot_hint">Anime checkpoints (Runware/NovelAI) want Danbooru tags; FLUX (Pollinations) wants sentences. Auto picks correctly — only override if you know why.</small>
                <label for="snapshot_forced">Always-append quality tags</label>
                <textarea id="snapshot_forced" class="text_pole textarea_compact" rows="2"></textarea>
                <small class="snapshot_hint">Appended to the end of every prompt. While left at default, it auto-adapts to the backend (Illustrious block for Runware, NAI V4.5 block for NovelAI, cinematic block for Pollinations). Edit it and your version is used everywhere.</small>
                <label for="snapshot_negative">Negative prompt</label>
                <textarea id="snapshot_negative" class="text_pole textarea_compact" rows="2"></textarea>
                <small class="snapshot_hint">What the image model should avoid. While left at default, it auto-adapts to the backend (NAI gets the V4.5-tuned block). FLUX mostly ignores negatives; tag models use them heavily.</small>
                <label for="snapshot_extra_rules">Extra builder rules (optional)</label>
                <textarea id="snapshot_extra_rules" class="text_pole textarea_compact" rows="2" placeholder="e.g. Only ever depict up to 2 characters"></textarea>
                <small class="snapshot_hint">Your standing instructions for the prompt builder, applied to every image.</small>
                <label for="snapshot_strip">Strip from scene before building (regex, one per line)</label>
                <textarea id="snapshot_strip" class="text_pole textarea_compact" rows="3"></textarea>
                <small class="snapshot_hint">Removed from the message before prompt building. Defaults cover &lt;details&gt; blocks, {ALLCAPS}…{/ALLCAPS} tracker blocks, and HTML comments — so stat trackers never displace the final scene beat.</small>

                <hr>
                <label>Character cast (appearance sheets, one per line: <code>Name: tags</code>)</label>
                <small class="snapshot_hint">Locked appearance tags per character = no more hair/eye/outfit drift between images. Casts are global; each chat remembers which cast is active — one cast per story world.</small>
                <div class="flex-container">
                    <select id="snapshot_cast_select" class="text_pole flex1"></select>
                    <div id="snapshot_cast_new" class="menu_button menu_button_icon fa-solid fa-plus" title="New cast"></div>
                    <div id="snapshot_cast_delete" class="menu_button menu_button_icon fa-solid fa-trash" title="Delete cast"></div>
                </div>
                <textarea id="snapshot_cast_sheet" class="text_pole textarea_compact" rows="6" placeholder="Jovan: boy, short black hair, red eyes, tall, lean build, academy uniform"></textarea>
                <div class="flex-container">
                    <div id="snapshot_cast_build" class="menu_button">Auto-build cast from chat</div>
                    <div id="snapshot_cast_clear" class="menu_button">Clear cast</div>
                    <div id="snapshot_test" class="menu_button">Test backend</div>
                    <div id="snapshot_test_builder" class="menu_button">Test builder</div>
                    <div id="snapshot_debug" class="menu_button">Show last generation</div>
                    <div id="snapshot_reset" class="menu_button">Reset defaults</div>
                </div>
                <small class="snapshot_hint">Auto-build: reads story memory first (Summaryception canon notepad + summary snippets, Author's Note), then recent chat, and appends new characters (review the result). Test backend: generates one small image and reports the time. Test builder: runs the prompt-builder LLM on a sample scene and shows its output or the exact error. Show last generation: the raw builder output, final prompt(s), negative, and any error from the most recent image — the first thing to check when a result looks wrong. (Full streaming logs need the browser console, e.g. Eruda on mobile.) Reset: restores tuned defaults — keeps API key, Runware model, casts, extra rules, builder profile, and backend.</small>
                <small class="snapshot_hint">Per message: the panorama icon regenerates the image only — the text is never touched; each attempt joins a swipeable gallery. /snap does the same for the last AI message.</small>
            </div>
        </div>
    </div>`;
}

function refreshProfileOptions() {
    const ctx = getContext();
    const profiles = ctx.extensionSettings?.connectionManager?.profiles || [];
    const $sel = $('#snapshot_profile');
    if (!$sel.length) return;
    $sel.empty().append('<option value="">— Main API (current connection) —</option>');
    for (const p of profiles) {
        $sel.append($('<option>').val(p.id).text(p.name || p.id));
    }
    $sel.val(profiles.some(p => p.id === settings.builderProfile) ? settings.builderProfile : '');
}

function refreshCastUI() {
    const $sel = $('#snapshot_cast_select');
    if (!$sel.length) return;
    const active = getActiveCastName();
    $sel.empty();
    for (const name of Object.keys(settings.casts)) {
        $sel.append($('<option>').val(name).text(name));
    }
    $sel.val(active);
    $('#snapshot_cast_sheet').val(settings.casts[active] || '');
}

function toggleBackendBlocks() {
    $('.snapshot_backend_block').hide();
    const known = ['novelai', 'runware', 'nanogpt'];
    $(`#snapshot_${known.includes(settings.backend) ? settings.backend : 'pollinations'}_block`).show();
}

function syncUI() {
    $('#snapshot_enabled').prop('checked', settings.enabled);
    $('#snapshot_auto').prop('checked', settings.auto);
    $('#snapshot_autocast').prop('checked', settings.autoCast);
    $('#snapshot_backend').val(settings.backend);
    $('#snapshot_size').val(settings.sizePreset);
    $('#snapshot_style').val(settings.promptStyle);
    $('#snapshot_panels').val(settings.maxPanels);
    $('#snapshot_bubbles').prop('checked', settings.dialogueBubbles);
    $('#snapshot_forced').val(settings.forcedTags);
    $('#snapshot_negative').val(settings.negativePrompt);
    $('#snapshot_extra_rules').val(settings.extraRules);
    $('#snapshot_strip').val(settings.stripPatterns);
    $('#snapshot_runware_key').val(settings.runwareKey);
    $('#snapshot_runware_model').val(settings.runwareModel);
    $('#snapshot_runware_steps').val(settings.runwareSteps);
    $('#snapshot_runware_cfg').val(settings.runwareCfg);
    $('#snapshot_runware_scheduler').val(settings.runwareScheduler);
    $('#snapshot_nai_model').val(settings.naiModel);
    $('#snapshot_nai_steps').val(settings.naiSteps);
    $('#snapshot_nai_scale').val(settings.naiScale);
    $('#snapshot_poll_model').val(settings.pollModel);
    $('#snapshot_nanogpt_key').val(settings.nanogptKey);
    $('#snapshot_nanogpt_model').val(settings.nanogptModel);
    $('#snapshot_nanogpt_steps').val(settings.nanogptSteps);
    $('#snapshot_nanogpt_cfg').val(settings.nanogptCfg);
    toggleBackendBlocks();
    refreshProfileOptions();
    refreshCastUI();
}

// Settings that survive a reset: credentials, model choice, and user-authored content.
const RESET_KEEP_KEYS = ['runwareKey', 'runwareModel', 'casts', 'extraRules', 'builderProfile', 'backend', 'nanogptKey', 'nanogptModel'];

function resetToDefaults() {
    const kept = {};
    for (const key of RESET_KEEP_KEYS) kept[key] = settings[key];
    for (const [key, value] of Object.entries(defaultSettings)) {
        settings[key] = (typeof value === 'object' && value !== null) ? structuredClone(value) : value;
    }
    Object.assign(settings, kept);
    saveSettingsDebounced();
    syncUI();
}

function bindSettings() {
    $('#snapshot_enabled').on('change', function () { settings.enabled = this.checked; saveSettingsDebounced(); });
    $('#snapshot_auto').on('change', function () { settings.auto = this.checked; saveSettingsDebounced(); });
    $('#snapshot_autocast').on('change', function () { settings.autoCast = this.checked; saveSettingsDebounced(); });
    $('#snapshot_backend').on('change', function () { settings.backend = this.value; toggleBackendBlocks(); saveSettingsDebounced(); });
    $('#snapshot_size').on('change', function () { settings.sizePreset = this.value; saveSettingsDebounced(); });
    $('#snapshot_style').on('change', function () { settings.promptStyle = this.value; saveSettingsDebounced(); });
    $('#snapshot_panels').on('input', function () { settings.maxPanels = Math.min(6, Math.max(1, Number(this.value) || 1)); saveSettingsDebounced(); });
    $('#snapshot_bubbles').on('change', function () { settings.dialogueBubbles = this.checked; saveSettingsDebounced(); });
    $('#snapshot_profile').on('change', function () { settings.builderProfile = this.value; saveSettingsDebounced(); });
    $('#snapshot_forced').on('input', function () { settings.forcedTags = this.value; saveSettingsDebounced(); });
    $('#snapshot_negative').on('input', function () { settings.negativePrompt = this.value; saveSettingsDebounced(); });
    $('#snapshot_extra_rules').on('input', function () { settings.extraRules = this.value; saveSettingsDebounced(); });
    $('#snapshot_strip').on('input', function () { settings.stripPatterns = this.value; saveSettingsDebounced(); });

    $('#snapshot_runware_key').on('input', function () { settings.runwareKey = this.value; saveSettingsDebounced(); });
    $('#snapshot_runware_model').on('input', function () { settings.runwareModel = this.value; saveSettingsDebounced(); });
    $('#snapshot_runware_steps').on('input', function () { settings.runwareSteps = Number(this.value) || 26; saveSettingsDebounced(); });
    $('#snapshot_runware_cfg').on('input', function () { settings.runwareCfg = Number(this.value) || 5; saveSettingsDebounced(); });
    $('#snapshot_runware_scheduler').on('input', function () { settings.runwareScheduler = this.value; saveSettingsDebounced(); });

    $('#snapshot_nai_model').on('change', function () { settings.naiModel = this.value; saveSettingsDebounced(); });
    $('#snapshot_nai_steps').on('input', function () { settings.naiSteps = Number(this.value) || 28; saveSettingsDebounced(); });
    $('#snapshot_nai_scale').on('input', function () { settings.naiScale = Number(this.value) || 5; saveSettingsDebounced(); });

    $('#snapshot_poll_model').on('input', function () { settings.pollModel = this.value; saveSettingsDebounced(); });

    $('#snapshot_nanogpt_key').on('input', function () { settings.nanogptKey = this.value; saveSettingsDebounced(); });
    $('#snapshot_nanogpt_model').on('input', function () { settings.nanogptModel = this.value; saveSettingsDebounced(); });
    $('#snapshot_nanogpt_steps').on('input', function () { settings.nanogptSteps = Number(this.value) || 30; saveSettingsDebounced(); });
    $('#snapshot_nanogpt_cfg').on('input', function () { settings.nanogptCfg = Number(this.value) || 7.5; saveSettingsDebounced(); });

    $('#snapshot_reset').on('click', () => {
        if (!window.confirm('Reset SceneSnap to default settings?\n\nKept: API key, Runware model, cast sheets, extra rules, builder profile, backend choice.')) return;
        resetToDefaults();
        toastr.success('Defaults restored', 'SceneSnap');
    });

    $('#snapshot_cast_select').on('change', function () {
        setActiveCastName(this.value);
        $('#snapshot_cast_sheet').val(settings.casts[this.value] || '');
    });
    $('#snapshot_cast_sheet').on('input', function () {
        settings.casts[getActiveCastName()] = this.value;
        saveSettingsDebounced();
    });
    $('#snapshot_cast_new').on('click', () => {
        const name = window.prompt('New cast name:');
        if (!name || settings.casts[name]) return;
        settings.casts[name] = '';
        saveSettingsDebounced();
        setActiveCastName(name);
        refreshCastUI();
    });
    $('#snapshot_cast_delete').on('click', () => {
        const name = getActiveCastName();
        if (name === 'Default') { toastr.warning('The Default cast cannot be deleted', 'SceneSnap'); return; }
        if (!window.confirm(`Delete cast "${name}"?`)) return;
        delete settings.casts[name];
        saveSettingsDebounced();
        setActiveCastName('Default');
        refreshCastUI();
    });
    $('#snapshot_cast_build').on('click', () => autoBuildCast({ silent: false }));
    $('#snapshot_cast_clear').on('click', () => {
        const name = getActiveCastName();
        if (!window.confirm(`Clear cast "${name}"? It re-seeds from story memory on the next illustration.`)) return;
        settings.casts[name] = '';
        saveSettingsDebounced();
        refreshCastUI();
        toastr.success(`Cast "${name}" cleared`, 'SceneSnap');
    });

    $('#snapshot_debug').on('click', () => {
        if (!lastDebug) { toastr.info('No generation yet this session', 'SceneSnap'); return; }
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const html = `<div style="text-align:left;max-height:70vh;overflow:auto">
            <h4>SceneSnap — last generation</h4>
            <b>${esc(lastDebug.time)} · v${esc(lastDebug.engine || '?')} · ${esc(lastDebug.backend)} · ${esc(lastDebug.style)}${lastDebug.error ? ' · <span style=\"color:#e66\">FAILED</span>' : ''}</b>
            ${lastDebug.error ? `<h5>Error</h5><pre style="white-space:pre-wrap;color:#e66">${esc(lastDebug.error)}</pre>` : ''}
            <h5>Final prompt(s) sent to the image model</h5><pre style="white-space:pre-wrap">${esc((lastDebug.prompts || []).join('\n\n--- panel ---\n\n')) || '(none)'}</pre>
            <h5>Negative</h5><pre style="white-space:pre-wrap">${esc(lastDebug.negative)}</pre>
            <h5>Raw builder output</h5><pre style="white-space:pre-wrap">${esc(lastDebug.raw)}</pre>
        </div>`;
        callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });


    $('#snapshot_test_builder').on('click', async function () {
        const $btn = $(this);
        $btn.addClass('disabled');
        try {
            const style = resolveStyle();
            const system = style === 'tags' ? TAG_SYSTEM_PROMPT : NATURAL_SYSTEM_PROMPT;
            const user = 'CHARACTER SHEETS:\nMira: girl, short silver hair, blue eyes, school uniform\n\nSCENE (illustrate its final moment):\nMira sprinted across the courtyard as the bell rang, students crowding the walkways, and leapt to catch the falling book one-handed.';
            const t0 = Date.now();
            const raw = await callLLM(system, user, 400);
            console.log('[SceneSnap] test builder output:', raw);
            toastr.success(`Builder OK in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${String(raw).trim().slice(0, 140)}...`, 'SceneSnap', { timeOut: 12000 });
        } catch (err) {
            notifyError(err);
        } finally {
            $btn.removeClass('disabled');
        }
    });


    $('#snapshot_test').on('click', async function () {
        const $btn = $(this);
        $btn.addClass('disabled');
        try {
            const style = resolveStyle();
            const positive = style === 'tags'
                ? '1girl, silver hair, long hair, blue eyes, smile, portrait, simple background, masterpiece, best quality'
                : 'Anime illustration. A close-up portrait of a smiling girl with long silver hair and blue eyes against a simple soft background.';
            const t0 = Date.now();
            const result = await generateWithBackend(positive, effectiveNegative());
            if (!result?.data) throw new Error('Backend returned no image');
            toastr.success(`Backend OK — image generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`, 'SceneSnap');
        } catch (err) {
            notifyError(err);
        } finally {
            $btn.removeClass('disabled');
        }
    });

    syncUI();
}

// ------------------------------------------------------------------ slash command + wand

async function registerSlashCommand() {
    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        const { SlashCommandArgument, ARGUMENT_TYPE } = await import('../../../slash-commands/SlashCommandArgument.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'snap',
            callback: async (_args, value) => {
                const id = (value !== undefined && value !== '' && !isNaN(Number(value))) ? Number(value) : findLastAiMessageId();
                if (id === null) { toastr.warning('No AI message to illustrate', 'SceneSnap'); return ''; }
                await illustrateMessage(id, { force: true });
                return '';
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: 'message id (default: last AI message)', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: false }),
            ],
            helpString: 'SceneSnap: generate a scene illustration for the given (or last) AI message.',
        }));
    } catch (err) {
        console.warn('[SceneSnap] Slash command registration failed', err);
    }
}

function addWandButton() {
    const html = `
    <div id="snapshot_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <i class="fa-solid fa-panorama"></i>
        <span>Illustrate last scene</span>
    </div>`;
    $('#extensionsMenu').append(html);
    $('#snapshot_wand').on('click', () => {
        const id = findLastAiMessageId();
        if (id === null) { toastr.warning('No AI message to illustrate', 'SceneSnap'); return; }
        illustrateMessage(id, { force: true });
    });
}

// ------------------------------------------------------------------ init

jQuery(async () => {
    extension_settings[MODULE] = extension_settings[MODULE] || {};
    settings = extension_settings[MODULE];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = (typeof value === 'object' && value !== null) ? structuredClone(value) : value;
        }
    }
    if (!settings.casts || typeof settings.casts !== 'object' || !Object.keys(settings.casts).length) {
        settings.casts = { 'Default': '' };
    }

    $('#extensions_settings2').append(settingsHtml());
    bindSettings();
    addWandButton();
    await registerSlashCommand();

    $(document).on('click', '.snapshot_mes_btn', function () {
        const mesId = Number($(this).closest('.mes').attr('mesid'));
        if (!isNaN(mesId)) illustrateMessage(mesId, { force: true });
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.APP_READY, () => setTimeout(() => { addAllMessageButtons(); refreshProfileOptions(); refreshCastUI(); markSceneSnapMedia(); }, 1000));

    setTimeout(addAllMessageButtons, 2000);
    console.log(`[SceneSnap] v${VERSION} loaded`);
});

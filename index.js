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
const VERSION = '0.10.1';

const defaultSettings = Object.freeze({
    enabled: true,
    auto: true,
    autoCast: true,
    backend: 'pollinations', // pollinations | runware | novelai
    promptStyle: 'auto',     // auto | tags | natural
    sizePreset: 'portrait',  // portrait | landscape | square
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
});

const SIZE_PRESETS = {
    portrait: { width: 832, height: 1216 },
    landscape: { width: 1216, height: 832 },
    wide: { width: 1344, height: 768 },
    square: { width: 1024, height: 1024 },
};

// Applied automatically while the user hasn't customized the matching field.
const BACKEND_QUALITY = {
    novelai: 'very aesthetic, masterpiece, no text, detailed background',
    pollinations: 'highly detailed, cinematic lighting, rich detailed background',
};
const BACKEND_NEGATIVE = {
    novelai: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, watermark, film grain, scan artifacts',
};

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
Rules: visual traits only — never personality, locations, positions, or current actions. Max 12 tags per character, Danbooru-style tags, prefer information from character tracker blocks when present, skip characters already listed in EXISTING SHEET. ALWAYS include the story's protagonist/viewpoint character — the player's character counts as a character. If a required character's appearance is never described, still output their line as: Name: gender, (appearance unknown — fill in). If there are no new characters at all, output NONE.`;

// One canonical dialogue-bubble contract, cited by both builder paths — never restated.
const BUBBLE_RULES = `DIALOGUE BUBBLES (active):
Alongside each panel prompt, pick 0-2 spoken lines for that panel's beat, copied VERBATIM from the SCENE text — never invent, paraphrase, translate, or merge lines. Prefer ONE line per panel, spreading the dialogue across panels in speaking order; put two lines in one panel only for a tight same-beat exchange, and never repeat a line across panels. Max 12 words per line; prefer the punchiest dialogue of the beat. "speaker" is the exact character name. If the beat has no spoken dialogue, use an empty array. The image prompt itself must still contain no dialogue or quotation marks — spoken lines go ONLY in the bubbles field; SceneSnap draws them onto the image afterward.`;

// Explicit scenes get explicit tags: vagueness is the accuracy killer in NSFW beats,
// and body position accuracy is the hardest part of any scene. One canonical rule.
const NSFW_RULE = `

EXPLICIT SCENES: when the scene is sexual or nude, tag it exactly — never euphemize or fade to black. State per character: state of undress (specific garments removed/open), exposed anatomy with concrete danbooru anatomy tags (breast size class and nipples, penis/erection/testicles, pussy/vulva, pubic hair state, skin tone and texture details), and body proportions CONSISTENT with that character's cast tags in every panel. Name the exact position by its danbooru term (missionary, cowgirl position, doggystyle, standing sex, ...), the penetration or contact state, hand and leg placement, and fluids. In natural-language mode, express the same specifics as prose. Anatomy follows the cast sheet: if a character's sheet fixes sizes or marks, keep them identical in every image.`;

// One canonical grounding-authority rule, cited by both builder paths — never restated.
const GROUNDING_RULE = `

GROUND TRUTH: when a CURRENT WORLD STATE block is provided, it is authoritative — its ON SCREEN list defines who may be depicted (OFF SCREEN characters are forbidden even if the prose mentions them), and its per-character lines give current location, condition, activity, and clothing, overriding sheet defaults and any assumption. PRECEDING CONTEXT is reference only, for resolving pronouns, place, time, and outfits — the illustration always depicts the SCENE's final beat, never events from the preceding context.`;

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
    return settings.backend === 'pollinations' ? 'natural' : 'tags';
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

function getActiveCastName() {
    const ctx = getContext();
    const name = ctx.chatMetadata?.sceneSnapCast;
    if (name && Object.prototype.hasOwnProperty.call(settings.casts, name)) return name;
    return 'Default';
}

function setActiveCastName(name) {
    const ctx = getContext();
    if (!ctx.chatMetadata) return;
    ctx.chatMetadata.sceneSnapCast = name;
    (ctx.saveMetadataDebounced ?? ctx.saveMetadata)?.call(ctx);
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

function softSanitize(text, style) {
    try { return sanitizeBuilderOutput(text, style); } catch { return ''; }
}

// Curly quotes/apostrophes and whitespace runs must not defeat the verbatim check.
function normalizeForMatch(text) {
    return String(text)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

// Verbatim guarantee: a bubble renders only if its text literally occurs in the
// scene — invented dialogue can never reach the image. Order matters: verify
// FIRST, length-trim SECOND (a prefix of verified text is still verbatim; a
// trimmed string checked against the scene is not the same guarantee).
function sanitizeBubbles(list, sceneText) {
    if (!Array.isArray(list)) return [];
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
    if (maxPanels > 1 || wantBubbles) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                const obj = JSON.parse(match[0]);
                const arr = Array.isArray(obj?.panels) ? obj.panels : [];
                const panels = arr
                    .map(p => ({
                        prompt: softSanitize(String(p?.prompt ?? p ?? ''), style),
                        bubbles: wantBubbles ? sanitizeBubbles(p?.bubbles, sceneText) : [],
                    }))
                    .filter(p => p.prompt)
                    .slice(0, maxPanels);
                if (panels.length) {
                    panels.setting = stripLayoutMeta(String(obj?.setting ?? '')).slice(0, 300);
                    panels.dress = stripLayoutMeta(String(obj?.dress ?? '')).slice(0, 300);
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

// Append anchor tags to a prompt without duplicating tokens the prompt already has.
function appendAnchor(prompt, anchor) {
    const base = String(prompt || '');
    const have = new Set(base.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
    const add = String(anchor || '').split(',').map(t => t.trim()).filter(t => t && !have.has(t.toLowerCase()));
    return add.length ? `${base}, ${add.join(', ')}` : base;
}

// Backstop when the builder returns no dress field: the cast sheet IS the world's
// wardrobe. Mine garment-bearing tags (generic garment lexicon, not world-specific).
function mineDressTags(castText) {
    const garments = ['kimono', 'kosode', 'hakama', 'haori', 'shihakusho', 'shihakush\u014d', 'sash', 'obi', 'uniform', 'armband', 'robe', 'cloak', 'cape', 'coat', 'dress', 'skirt', 'scarf', 'hat', 'gloves', 'boots', 'suit'];
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
    let fullSystem = system;
    if (settings.backend === 'novelai' && style === 'tags') {
        fullSystem += '\n\nTARGET MODEL: NovelAI Diffusion V4.5 — blend Danbooru tags with a few short natural phrases used as tags (e.g. "moonlit stone alley at night", "crowded arena under harsh sun"); count tags and sheet-verbatim appearance rules still apply.';
    }
    if (grounding.has) fullSystem += GROUNDING_RULE;
    fullSystem += NSFW_RULE;
    const bubbleSchema = bubblesOn ? ',"bubbles":[{"speaker":"<name>","text":"<verbatim quote>"}]' : '';
    if (maxPanels > 1) {
        fullSystem += `\n\nSEQUENCE MODE (active):\nBuild a vertical comic strip: decide how many panels (2 to ${maxPanels}) the scene's climax needs — one panel per DISTINCT visual beat, chronological order, ending on the final beat. Never fewer than 2 panels: the reader asked for a strip. Every character repeats their FULL appearance tag set verbatim in every panel they appear in — never change outfits, hair, or colors between panels. Each panel prompt describes exactly ONE moment in ONE frame — never write layout words (comic, panel, panels, page, grid, multiple views).
PANEL DISCIPLINE (binding rules for every panel):
- Panels are the SCENE's beats in strict chronological order, first key moment to last — and the climax action itself (the strike, the explosion, the reveal) MUST be one of the panels; a strip that skips its own climax is a failed strip.
- CONTINUITY: consecutive panels are one continuous moment in one place — carry the previous panel's consequences forward (smoke from a blast lingers in the next panel; wounds, debris, and damage persist; light and weather never change mid-scene). No panel may contradict a state an earlier panel established.
- When someone acts ON another person (healing, striking, carrying, restraining), the panel shows BOTH — the object of the action is never cropped out. A medic kneels beside a VISIBLE patient.
- Up to FOUR named characters per panel when the beat genuinely needs them; prefer the fewest that carry it — solo close-ups bind a character's look perfectly. Open with exact danbooru count tags (1boy / 1girl / 2boys, 1girl / multiple boys ...), then each character's FULL cast tag set as one contiguous block, primary character first. Never interleave two characters' traits.
- Clothing comes ONLY from cast tags and explicit scene wording. NEVER derive clothing or armor from rank/role words: 'officer', 'captain', 'soldier', 'guard', 'division' are jobs, not outfits — writing 'military uniform' because the scene says 'officers' is a failed panel.
- A background crowd is scenery: give it ONE collective emotion and describe its dress by copying the scene's world (what these people canonically wear), never by role words.
- The panel's speaker (if it has a bubble) is drawn mid-speech, body and face oriented toward whoever they address — a speaker addressing a crowd faces the crowd, not the camera.
- Actions are single concrete danbooru tags (clapping, arms crossed, pointing, hand on own chest) — never compound phrases like 'hands clapping together', which image models misread.
- A line spoken to a group is drawn as the speaker prominent with the addressed group visible and attending — never a private two-shot for a public address.
WORLD (derive once, as data): from the SCENE text and CAST tags, infer this world's shared clothing style and this scene's physical setting. "dress" is ONLY the universal base outfit every ordinary person wears — never rank- or status-specific garments (captain's coats/haori, armbands, crowns, insignia): those belong exclusively to the cast tags of whoever holds the rank. Never modernize: no modern uniforms, coats, neckties, or architecture unless cast tags or scene text explicitly describe them. Output both as flat tag lists in the top-level "dress" and "setting" fields — the extension stamps them onto every panel itself, so do NOT restate them inside panel prompts.${bubblesOn ? '\n\n' + BUBBLE_RULES : ''}\nOUTPUT (replaces the single-line requirement above): strict JSON only — no reasoning, no commentary, no markdown: {"setting":"<location/environment tags for this scene>","dress":"<what people of this world wear, as tags>","panels":[{"prompt":"<one prompt following all rules above>"${bubbleSchema}}]}`;
    } else if (bubblesOn) {
        fullSystem += `\n\n${BUBBLE_RULES}\nOUTPUT (replaces the single-line requirement above): strict JSON only — no reasoning, no commentary, no markdown, exactly one panel: {"panels":[{"prompt":"<one prompt following all rules above>"${bubbleSchema}}]}`;
    }

    const maxTokens = maxPanels > 1 ? Math.min(3200, 400 + 550 * maxPanels) : (bubblesOn ? 950 : 800);
    let raw;
    try {
        raw = await callLLM(fullSystem, user, maxTokens);
    } catch (firstErr) {
        console.warn('[SceneSnap] builder attempt 1 failed, retrying once:', firstErr);
        raw = await callLLM(fullSystem, user, maxTokens);
    }
    console.log('[SceneSnap] raw builder output:', String(raw).slice(0, 600));
    const panels = parsePanels(raw, style, maxPanels, { bubbles: bubblesOn, sceneText: scene });
    // World anchor: builder-derived, cast-mined as backstop. Stamped onto every panel by
    // the extension (appendAnchor) — per-panel drift to modern dress/architecture becomes
    // structurally impossible instead of being a memory test for the builder.
    const dress = panels.dress || mineDressTags(getActiveCastSheet());
    return { panels, style, raw: String(raw), setting: panels.setting || '', dress };
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
            steps: Math.min(Math.max(1, Number(settings.naiSteps) || 28), 28),
            scale: Number(settings.naiScale) || 5,
            width,
            height,
            negative_prompt: negative,
            seed: Number.isInteger(seed) ? seed : -1,
            sm: false,
            sm_dyn: false,
            decrisper: false,
            variety_boost: true,
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

async function generateWithBackend(positive, negative, landscape, seed) {
    switch (settings.backend) {
        case 'runware': return generateRunware(positive, negative, landscape, seed);
        case 'novelai': return generateNovelAI(positive, negative, landscape, seed);
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
        if (settings.autoCast && !getActiveCastSheet()) {
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

        const negative = effectiveNegative();
        let panelImages = [];
        let panelFormat = 'png';
        let positive = '';
        let debugRaw = '';
        let debugPrompts = [];


            const { panels, style, raw, setting, dress } = await buildScenePrompt(mesId);
            const anchor = [setting, dress].filter(Boolean).join(', ');
            const finals = panels.map(p => composePositive(appendAnchor(p.prompt, anchor), style));
            debugRaw = raw;
            debugPrompts = finals.slice();
            panels.forEach((p, i) => p.bubbles.forEach(b => debugPrompts.push(`PANEL ${i + 1} BUBBLE — ${b.speaker || '?'}: "${b.text}"`)));
            console.log(`[SceneSnap] ${finals.length} panel(s) (${style}):`, finals);
            // One seed for the whole strip: same character rendering in every panel.
            const runSeed = Math.floor(Math.random() * 2 ** 31);
            for (let i = 0; i < panels.length; i++) {
                const result = await generateWithBackend(finals[i], negative, panels.length > 1, runSeed);
                panelFormat = result.format || panelFormat;
                let imageB64 = result.isUrl ? await urlToBase64(result.data) : result.data;
                if (panels[i].bubbles.length) {
                    try { imageB64 = await overlayBubbles(imageB64, panelFormat, panels[i].bubbles); }
                    catch (e) { console.warn('[SceneSnap] bubble overlay failed, shipping the clean panel:', e); }
                }
                panelImages.push(imageB64);
            }
        positive = finals.join('  \u25ba  ');


        lastDebug = { time: new Date().toLocaleTimeString(), backend: settings.backend, style: resolveStyle(), raw: debugRaw, prompts: debugPrompts, negative, error: null };

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
        else lastDebug = { time: new Date().toLocaleTimeString(), backend: settings.backend, style: resolveStyle(), raw: '(builder did not run)', prompts: [], negative: effectiveNegative(), error: msg };
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

async function autoBuildCast({ silent = false } = {}) {
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
            `EXISTING SHEET (skip these characters):\n${getActiveCastSheet() || '(empty)'}`,
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
        settings.casts[cast] = mergeCastLines(String(settings.casts[cast] || ''), cleaned);
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
                        <div class="flex1"><label for="snapshot_nai_steps">Steps (≤28)</label><input id="snapshot_nai_steps" type="number" min="1" max="28" class="text_pole"></div>
                        <div class="flex1"><label for="snapshot_nai_scale">Scale</label><input id="snapshot_nai_scale" type="number" min="1" max="10" step="0.5" class="text_pole"></div>
                    </div>
                    <small class="snapshot_hint">Steps capped at 28 — the free-generation limit on Opus. Scale = prompt adherence, ~5 for V4.5.</small>
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
                    <option value="tags">Danbooru tags</option>
                    <option value="natural">Natural language</option>
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
    $(`#snapshot_${settings.backend === 'novelai' ? 'novelai' : settings.backend === 'runware' ? 'runware' : 'pollinations'}_block`).show();
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
    toggleBackendBlocks();
    refreshProfileOptions();
    refreshCastUI();
}

// Settings that survive a reset: credentials, model choice, and user-authored content.
const RESET_KEEP_KEYS = ['runwareKey', 'runwareModel', 'casts', 'extraRules', 'builderProfile', 'backend'];

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

    $('#snapshot_debug').on('click', () => {
        if (!lastDebug) { toastr.info('No generation yet this session', 'SceneSnap'); return; }
        const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const html = `<div style="text-align:left;max-height:70vh;overflow:auto">
            <h4>SceneSnap — last generation</h4>
            <b>${esc(lastDebug.time)} · ${esc(lastDebug.backend)} · ${esc(lastDebug.style)}${lastDebug.error ? ' · <span style="color:#e66">FAILED</span>' : ''}</b>
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

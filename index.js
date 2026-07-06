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
    naiToken: '',
    naiMultiChar: true,
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

const MULTICHAR_SYSTEM_PROMPT = `You are an image prompt engineer for NovelAI Diffusion V4.5, which supports separate prompts per character. Convert the final moment of a roleplay scene into a structured multi-character image spec.

OUTPUT: strict JSON only — no reasoning, no markdown, no commentary:
{"base":"<scene prompt>","characters":[{"tags":"<one character's prompt>"}]}

HOW TO FILL IT:
- "base" = the SCENE only: count tag for how many people are visible (1boy, 2boys, 1boy 1girl...), the setting, background, crowd/audience if present, weather, time of day, camera framing, motion/impact tags, and quality tags. The base describes the world and composition, NOT individual appearances.
- "characters" = one entry per NAMED character physically visible in the final frame, in left-to-right order. Each "tags" value is that ONE person's Danbooru tags: their appearance copied verbatim from CHARACTER SHEETS (hair, eyes, build, clothing) PLUS what they are doing this instant (pose, expression, action). Start each with a solo count tag (1boy or 1girl).

CRITICAL RULES:
- The sheets are the ONLY source for each character's hair, eyes, build, and default clothing. NEVER invent appearance. If the scene states current clothing/state (from a header or the prose), that overrides the sheet default for that character.
- Put quality/style tags ONLY in "base", never inside a character entry — it weakens identity separation.
- A crowd or audience is scenery: tag it in "base" (crowd, audience, spectators). NEVER make a character entry for background people.
- Only include characters who are physically present in the final frame. Never add characters who are merely mentioned, remembered, or off-screen.
- Maximum 4 character entries. If more than 4 people are foregrounded, keep the 4 most central and fold the rest into a "base" crowd tag.
- Keep every character's age and relative size consistent with their sheet; never render anyone as a child unless the sheet says so.
- No names as tags, no dialogue, no story text.`;

const CAST_SYSTEM_PROMPT = `You extract character appearance sheets for an anime image model from a roleplay story.
STORY MEMORY (established canon, summary snippets, author's note) is your PRIMARY source for appearances — it accumulates the whole story. Use the recent chat excerpt only for characters memory has not captured yet.
Output one line per NEW named character, in exactly this format and nothing else:
Name: girl|boy|woman|man, hair length + hair color, eye color, 2-5 distinctive physical tags, default outfit tags
Example:
Akane: girl, long black hair, ponytail, brown eyes, athletic build, school uniform, red ribbon
Rules: visual traits only — never personality, locations, positions, or current actions. Max 12 tags per character, Danbooru-style tags, prefer information from character tracker blocks when present, skip characters already listed in EXISTING SHEET. ALWAYS include the story's protagonist/viewpoint character — the player's character counts as a character. If a required character's appearance is never described, still output their line as: Name: gender, (appearance unknown — fill in). If there are no new characters at all, output NONE.`;

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

function getSize() {
    return SIZE_PRESETS[settings.sizePreset] || SIZE_PRESETS.portrait;
}

function resolveStyle() {
    if (settings.promptStyle === 'tags' || settings.promptStyle === 'natural') return settings.promptStyle;
    return settings.backend === 'pollinations' ? 'natural' : 'tags';
}

function notifyError(err) {
    console.error('[SceneSnap]', err);
    try { toastr.error(String(err?.message || err).slice(0, 300), 'SceneSnap', { timeOut: 10000 }); } catch { /* noop */ }
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

    t = t.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('Prompt builder output was empty after cleanup');
    return t.slice(0, 1500);
}

function softSanitize(text, style) {
    try { return sanitizeBuilderOutput(text, style); } catch { return ''; }
}

function parsePanels(raw, style, maxPanels) {
    const cleaned = String(raw)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json\n?|```/gi, '')
        .trim();
    if (maxPanels > 1) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                const obj = JSON.parse(match[0]);
                const arr = Array.isArray(obj?.panels) ? obj.panels : [];
                const prompts = arr
                    .map(p => softSanitize(String(p?.prompt ?? p ?? ''), style))
                    .filter(Boolean)
                    .slice(0, maxPanels);
                if (prompts.length) return prompts;
            } catch { /* fall through to regex recovery */ }
        }
        // Truncated/dirty JSON: recover every completed "prompt":"..." value.
        const recovered = [];
        const rx = /"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let hit;
        while ((hit = rx.exec(cleaned)) !== null) {
            const text = softSanitize(hit[1].replace(/\\"/g, '"').replace(/\\n/g, ' '), style);
            if (text) recovered.push(text);
        }
        if (recovered.length) return recovered.slice(0, maxPanels);
    }
    return [sanitizeBuilderOutput(cleaned, style)];
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

// NovelAI position grid: columns A-E (x), rows 1-5 (y). Spread N characters across the middle row.
const NAI_CENTERS_BY_COUNT = {
    1: [{ x: 0.5, y: 0.5 }],
    2: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }],
    3: [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.5 }],
    4: [{ x: 0.2, y: 0.5 }, { x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.8, y: 0.5 }],
};

async function buildMultiCharSpec(mesId, scene) {
    const sheet = getActiveCastSheet();
    const extra = String(settings.extraRules || '').trim();
    const user = [
        sheet ? `CHARACTER SHEETS:\n${sheet}` : 'CHARACTER SHEETS: (none — infer only from what the scene explicitly states)',
        extra ? `EXTRA RULES:\n${extra}` : '',
        `SCENE (illustrate its final moment):\n${scene}`,
    ].filter(Boolean).join('\n\n');

    let raw;
    try {
        raw = await callLLM(MULTICHAR_SYSTEM_PROMPT, user, 1400);
    } catch (firstErr) {
        console.warn('[SceneSnap] multichar builder attempt 1 failed, retrying once:', firstErr);
        raw = await callLLM(MULTICHAR_SYSTEM_PROMPT, user, 1400);
    }
    console.log('[SceneSnap] raw multichar builder output:', String(raw).slice(0, 700));

    const cleaned = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```json\n?|```/gi, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Multi-character builder did not return JSON');
    let obj;
    try { obj = JSON.parse(match[0]); }
    catch (e) { throw new Error('Multi-character builder returned invalid JSON'); }

    let base = softSanitize(String(obj?.base ?? ''), 'tags');
    let chars = Array.isArray(obj?.characters) ? obj.characters : [];
    chars = chars
        .map(c => softSanitize(String(c?.tags ?? c ?? ''), 'tags'))
        .filter(Boolean)
        .slice(0, 4);
    if (!base) throw new Error('Multi-character builder produced an empty base prompt');
    if (!chars.length) throw new Error('Multi-character builder produced no character panels');
    return { base, chars, raw: String(raw) };
}

async function getSceneText(mesId) {
    const ctx = getContext();
    const message = ctx.chat?.[mesId];
    if (!message) throw new Error(`Message #${mesId} not found`);

    let scene = String(message.mes || '');

    // Strip stat/tracker blocks (configurable, one regex per line) so the tail of the
    // message is the final prose beat, not metadata.
    for (const line of String(settings.stripPatterns || '').split('\n')) {
        const pattern = line.trim();
        if (!pattern) continue;
        try {
            scene = scene.replace(new RegExp(pattern, 'gi'), '');
        } catch (e) {
            console.warn('[SceneSnap] invalid strip pattern skipped:', pattern, e);
        }
    }
    scene = scene.replace(/\n{3,}/g, '\n\n').trim();

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

    const user = [
        sheet ? `CHARACTER SHEETS:\n${sheet}` : 'CHARACTER SHEETS: (none provided — infer appearances only from what the scene text explicitly states)',
        extra ? `EXTRA RULES:\n${extra}` : '',
        `SCENE (illustrate its final moment):\n${scene}`,
    ].filter(Boolean).join('\n\n');

    const maxPanels = Math.min(6, Math.max(1, Number(settings.maxPanels) || 1));
    let fullSystem = system;
    if (settings.backend === 'novelai' && style === 'tags') {
        fullSystem += '\n\nTARGET MODEL: NovelAI Diffusion V4.5 — blend Danbooru tags with a few short natural phrases used as tags (e.g. "moonlit stone alley at night", "crowded arena under harsh sun"); count tags and sheet-verbatim appearance rules still apply.';
    }
    if (maxPanels > 1) {
        fullSystem += `\n\nSEQUENCE MODE (active):\nDecide how many panels (1 to ${maxPanels}) the scene's climax genuinely needs — one panel per DISTINCT visual beat, chronological order, ending on the final beat. Use 1 panel when one moment carries the scene. Characters keep identical appearance tags in every panel.\nOUTPUT (replaces the single-line requirement above): strict JSON only — no reasoning, no commentary, no markdown: {"panels":[{"prompt":"<one prompt following all rules above>"}]}`;
    }

    const maxTokens = maxPanels > 1 ? Math.min(3200, 400 + 550 * maxPanels) : 800;
    let raw;
    try {
        raw = await callLLM(fullSystem, user, maxTokens);
    } catch (firstErr) {
        console.warn('[SceneSnap] builder attempt 1 failed, retrying once:', firstErr);
        raw = await callLLM(fullSystem, user, maxTokens);
    }
    console.log('[SceneSnap] raw builder output:', String(raw).slice(0, 600));
    return { prompts: parsePanels(raw, style, maxPanels), style, raw: String(raw) };
}

// ------------------------------------------------------------------ backends

async function generateRunware(positive, negative) {
    const key = String(settings.runwareKey || '').trim();
    const model = String(settings.runwareModel || '').trim();
    if (!key) throw new Error('Runware API key is not set (SceneSnap settings)');
    if (!model) throw new Error('Runware model AIR is not set — copy it from the model page sidebar on Civitai (e.g. civitai:XXXXXX@XXXXXXX)');
    const { width, height } = getSize();

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

async function generateNovelAI(positive, negative) {
    const { width, height } = getSize();
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
            sm: false,
            sm_dyn: false,
            decrisper: false,
            variety_boost: true,
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`NovelAI: ${text || res.status} (is your NovelAI key set under API Connections?)`);
    }
    return { format: 'png', data: await res.text() };
}

async function generatePollinations(positive, negative) {
    const { width, height } = getSize();
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
            seed: Math.floor(Math.random() * 2 ** 31),
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Pollinations: ${text || res.status}`);
    }
    const data = await res.json();
    if (!data?.image) throw new Error('Pollinations returned no image');
    return { format: data?.format || 'jpg', data: data.image };
}

async function generateNovelAIMulti(base, charTags, negative) {
    const token = String(settings.naiToken || '').trim();
    if (!token) throw new Error('NovelAI persistent token not set — needed for multi-character mode (get it at NovelAI → User Settings → Account → Get Persistent API Token)');
    const { width, height } = getSize();
    const forced = effectiveForcedTags();
    const baseCaption = forced
        ? `${base}, ${forced.split(',').map(s => s.trim()).filter(s => s && !base.toLowerCase().includes(s.toLowerCase())).join(', ')}`.replace(/,\s*$/, '')
        : base;

    const centers = NAI_CENTERS_BY_COUNT[charTags.length] || NAI_CENTERS_BY_COUNT[4];
    const characterPrompts = charTags.map((tags, i) => ({
        prompt: tags,
        uc: '',
        center: centers[i] || { x: 0.5, y: 0.5 },
        enabled: true,
    }));
    const charCaptions = charTags.map((tags, i) => ({
        char_caption: tags,
        centers: [centers[i] || { x: 0.5, y: 0.5 }],
    }));

    const seed = Math.floor(Math.random() * 4294967295);
    const body = {
        input: baseCaption,
        model: settings.naiModel,
        action: 'generate',
        parameters: {
            params_version: 3,
            width,
            height,
            scale: Number(settings.naiScale) || 5,
            sampler: 'k_euler_ancestral',
            steps: Math.min(Math.max(1, Number(settings.naiSteps) || 28), 28),
            seed,
            n_samples: 1,
            ucPreset: 0,
            qualityToggle: true,
            dynamic_thresholding: false,
            controlnet_strength: 1,
            legacy: false,
            add_original_image: true,
            cfg_rescale: 0,
            noise_schedule: 'karras',
            legacy_v3_extend: false,
            skip_cfg_above_sigma: null,
            characterPrompts,
            use_coords: true,
            negative_prompt: negative,
            v4_prompt: {
                caption: { base_caption: baseCaption, char_captions: charCaptions },
                use_coords: true,
                use_order: true,
            },
            v4_negative_prompt: {
                caption: { base_caption: negative, char_captions: charTags.map(() => ({ char_caption: '', centers: [{ x: 0.5, y: 0.5 }] })) },
            },
        },
    };

    const res = await fetch('https://image.novelai.net/ai/generate-image', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 401) throw new Error('NovelAI rejected the token (401) — use a Persistent API Token, not your password');
        throw new Error(`NovelAI multi-char: ${res.status} ${text.slice(0, 200)}`);
    }
    // Response is a zip containing image_0.png — extract the first PNG.
    const buf = new Uint8Array(await res.arrayBuffer());
    const b64 = await extractFirstPngFromZip(buf);
    return { format: 'png', data: b64 };
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot decompress the NovelAI image (no DecompressionStream). Try a Chromium-based browser.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await stream.arrayBuffer());
}

// Zip reader for NAI responses: handles both STORED (method 0) and DEFLATE (method 8) entries.
async function extractFirstPngFromZip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    while (off + 30 <= bytes.length) {
        const sig = dv.getUint32(off, true);
        if (sig !== 0x04034b50) break; // local file header
        const method = dv.getUint16(off + 8, true);
        const compSize = dv.getUint32(off + 18, true);
        const nameLen = dv.getUint16(off + 26, true);
        const extraLen = dv.getUint16(off + 28, true);
        const dataStart = off + 30 + nameLen + extraLen;
        const fileData = bytes.subarray(dataStart, dataStart + compSize);
        if (method === 0) return bytesToBase64(fileData);
        if (method === 8) return bytesToBase64(await inflateRaw(fileData));
        off = dataStart + compSize;
    }
    throw new Error('Could not extract image from NovelAI response (unexpected zip format)');
}

async function generateWithBackend(positive, negative) {
    switch (settings.backend) {
        case 'runware': return generateRunware(positive, negative);
        case 'novelai': return generateNovelAI(positive, negative);
        default: return generatePollinations(positive, negative);
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
    const gutter = 16;
    const w = Math.max(...imgs.map(i => i.width));
    const scaled = imgs.map(i => ({ img: i, h: Math.round(i.height * (w / i.width)) }));
    const canvas = document.createElement('canvas');
    canvas.width = w + gutter * 2;
    canvas.height = scaled.reduce((sum, s) => sum + s.h, 0) + gutter * (imgs.length + 1);
    const cx = canvas.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, canvas.width, canvas.height);
    let y = gutter;
    for (const s of scaled) {
        cx.drawImage(s.img, gutter, y, w, s.h);
        y += s.h + gutter;
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('Comic strip stitching failed');
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

        const negative = effectiveNegative();
        const useMultiChar = settings.backend === 'novelai' && settings.naiMultiChar
            && String(settings.naiToken || '').trim() && parseCastSheet(getActiveCastSheet()).length > 0;

        let panelImages = [];
        let panelFormat = 'png';
        let positive = '';
        let debugRaw = '';
        let debugPrompts = [];

        if (useMultiChar) {
            // NovelAI native multi-character: base scene + per-character panels, single generation.
            const scene = await getSceneText(mesId);
            const spec = await buildMultiCharSpec(mesId, scene);
            debugRaw = spec.raw;
            debugPrompts = [`BASE: ${spec.base}`, ...spec.chars.map((c, i) => `CHAR ${i + 1}: ${c}`)];
            positive = debugPrompts.join('\n');
            const result = await generateNovelAIMulti(spec.base, spec.chars, negative);
            panelFormat = result.format || 'png';
            panelImages = [result.data];
            console.log(`[SceneSnap] NAI multi-char: 1 base + ${spec.chars.length} character panels`);
        } else {
            const { prompts, style, raw } = await buildScenePrompt(mesId);
            const finals = prompts.map(p => composePositive(p, style));
            debugRaw = raw;
            debugPrompts = finals;
            console.log(`[SceneSnap] ${finals.length} panel(s) (${style}):`, finals);
            for (const prompt of finals) {
                const result = await generateWithBackend(prompt, negative);
                panelFormat = result.format || panelFormat;
                panelImages.push(result.isUrl ? await urlToBase64(result.data) : result.data);
            }
            positive = finals.join('  \u25ba  ');
        }

        lastDebug = { time: new Date().toLocaleTimeString(), backend: settings.backend + (useMultiChar ? ' (multi-char)' : ''), style: useMultiChar ? 'nai-multichar' : resolveStyle(), raw: debugRaw, prompts: debugPrompts, negative, error: null };

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
        });
        msg.extra.media_index = msg.extra.media.length - 1;

        const $mes = $(`#chat .mes[mesid="${mesId}"]`);
        if ($mes.length) appendMediaToMessage(msg, $mes, 'keep');
        await ctx2.saveChat();
    } catch (err) {
        if (lastDebug) lastDebug.error = String(err?.message || err);
        else lastDebug = { time: new Date().toLocaleTimeString(), backend: settings.backend, style: resolveStyle(), raw: '(builder did not run)', prompts: [], negative: effectiveNegative(), error: String(err?.message || err) };
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

function onChatChanged() {
    suppressAutoUntil = Date.now() + 2500;
    autoDone.clear();
    setTimeout(() => {
        addAllMessageButtons();
        refreshCastUI();
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
                    <label class="checkbox_label"><input id="snapshot_nai_multichar" type="checkbox"><span>Multi-character mode (per-character panels)</span></label>
                    <small class="snapshot_hint">The big accuracy upgrade: sends each named character in the scene as its own NAI character panel (base scene + separate appearance per person), eliminating trait-bleed — the same structure that produces clean multi-person images in NAI's web UI. Needs the persistent token below and a cast sheet with the characters. Falls back to a single prompt when either is missing. Single-frame only (no comic panels).</small>
                    <label for="snapshot_nai_token">NovelAI persistent token (for multi-character mode)</label>
                    <input id="snapshot_nai_token" type="password" class="text_pole" placeholder="pst-..." autocomplete="off">
                    <small class="snapshot_hint">NovelAI → User Settings → Account → Get Persistent API Token. Different from the key ST uses for single-prompt mode. Only needed for multi-character mode.</small>
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
                <small class="snapshot_hint">1 = single frame. 2–6 = the builder decides per scene how many panels the climax needs, stitched top-to-bottom into one vertical strip (webtoon style). Each panel is a full generation — free on NAI Opus, pennies on Runware, but N× the wait. The console logs how many panels the builder chose.</small>

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
    $('#snapshot_nai_token').val(settings.naiToken);
    $('#snapshot_nai_multichar').prop('checked', settings.naiMultiChar);
    $('#snapshot_poll_model').val(settings.pollModel);
    toggleBackendBlocks();
    refreshProfileOptions();
    refreshCastUI();
}

// Settings that survive a reset: credentials, model choice, and user-authored content.
const RESET_KEEP_KEYS = ['runwareKey', 'runwareModel', 'naiToken', 'casts', 'extraRules', 'builderProfile', 'backend'];

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
    $('#snapshot_nai_token').on('input', function () { settings.naiToken = this.value.trim(); saveSettingsDebounced(); });
    $('#snapshot_nai_multichar').on('change', function () { settings.naiMultiChar = this.checked; saveSettingsDebounced(); });

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
    eventSource.on(event_types.APP_READY, () => setTimeout(() => { addAllMessageButtons(); refreshProfileOptions(); refreshCastUI(); }, 1000));

    setTimeout(addAllMessageButtons, 2000);
    console.log('[SceneSnap] loaded');
});

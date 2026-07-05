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

const MODULE = 'sceneSnap';

const defaultSettings = Object.freeze({
    enabled: true,
    auto: true,
    backend: 'pollinations', // pollinations | runware | novelai
    promptStyle: 'auto',     // auto | tags | natural
    sizePreset: 'portrait',  // portrait | landscape | square
    builderProfile: '',      // Connection Manager profile id ('' = main API)
    maxSceneChars: 6000,
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
    square: { width: 1024, height: 1024 },
};

const TAG_SYSTEM_PROMPT = `You are an image prompt engineer for a Danbooru-tag anime model (Illustrious / NoobAI / NovelAI family). Convert the final moment of a roleplay scene into ONE image prompt.

OUTPUT: a single line of comma-separated Danbooru tags. No sentences, no quotes, no markdown, no explanations.

PROCESS:
1. Identify the FINAL visual beat of the scene — the last thing a camera would see. One frozen frame, never a montage.
2. Decide who is physically visible in that frame. Start with count tags (1girl, 1boy, 2girls, 1boy 1girl, etc.).
3. For each visible character, copy their appearance tags from CHARACTER SHEETS exactly. Never invent hair colors, eye colors, or features.
4. Clothing: if the message contains a header or tracker stating the current timeline, location, or what characters are wearing right now, that information is authoritative and overrides sheet defaults.
5. Add: facial expression, pose/action, interaction tags (eye contact, holding hands, hug, etc. when applicable), camera framing (close-up / portrait / upper body / cowboy shot / full body / from behind / from side / pov), background/location, time of day, lighting.

RULES:
- 20 to 35 tags total. Fewer precise tags beat tag spam.
- Do not use character names as tags; use their appearance tags from the sheets instead.
- Never include tags for characters who are only mentioned, remembered, or off-screen.
- Never include story text, dialogue, or quotation marks.`;

const NATURAL_SYSTEM_PROMPT = `You write image prompts for a natural-language image model (FLUX family). Convert the final moment of a roleplay scene into ONE image prompt.

OUTPUT: 2-4 plain sentences describing a single frozen frame. Anime illustration style. No markdown, no quotes, no explanations.

PROCESS:
1. Identify the FINAL visual beat of the scene — the last thing a camera would see.
2. Describe only the characters physically visible in that frame, using their exact appearance details from CHARACTER SHEETS. Never invent hair colors, eye colors, or features.
3. Clothing: if the message contains a header or tracker stating the current timeline, location, or what characters are wearing right now, that information is authoritative and overrides sheet defaults.
4. Cover: expressions, pose/action, camera framing, setting, time of day, lighting. Begin with "Anime illustration."

RULES: no character names, no dialogue, no story text, one moment only.`;

const CAST_SYSTEM_PROMPT = `You extract character appearance sheets for an anime image model from a roleplay chat.
Output one line per NEW named character, in exactly this format and nothing else:
Name: girl|boy|woman|man, hair length + hair color, eye color, 2-5 distinctive physical tags, default outfit tags
Example:
Akane: girl, long black hair, ponytail, brown eyes, athletic build, school uniform, red ribbon
Rules: visual traits only (no personality), max 12 tags per character, Danbooru-style tags, prefer information from character tracker blocks when present, skip characters already listed in EXISTING SHEET. If there are no new characters, output NONE.`;

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
            const res = await ctx.ConnectionManagerRequestService.sendRequest(
                profileId,
                [{ role: 'system', content: system }, { role: 'user', content: user }],
                maxTokens,
            );
            const content = typeof res === 'string' ? res : res?.content;
            if (!content || !String(content).trim()) throw new Error('Prompt builder (profile) returned an empty response');
            return String(content);
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

function composePositive(built, style) {
    const forced = String(settings.forcedTags || '').trim();
    if (!forced) return built;
    if (style === 'natural') return `${built} ${forced.split(',').map(s => s.trim()).filter(Boolean).join(', ')}.`.trim();
    const have = new Set(built.toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
    const add = forced.split(',').map(s => s.trim()).filter(s => s && !have.has(s.toLowerCase()));
    return add.length ? `${built}, ${add.join(', ')}` : built;
}

async function buildScenePrompt(mesId) {
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

    const style = resolveStyle();
    const system = style === 'tags' ? TAG_SYSTEM_PROMPT : NATURAL_SYSTEM_PROMPT;
    const sheet = getActiveCastSheet();
    const extra = String(settings.extraRules || '').trim();

    const user = [
        sheet ? `CHARACTER SHEETS:\n${sheet}` : 'CHARACTER SHEETS: (none provided — infer appearances only from what the scene text explicitly states)',
        extra ? `EXTRA RULES:\n${extra}` : '',
        `SCENE (illustrate its final moment):\n${scene}`,
    ].filter(Boolean).join('\n\n');

    let raw;
    try {
        raw = await callLLM(system, user, 500);
    } catch (firstErr) {
        console.warn('[SceneSnap] builder attempt 1 failed, retrying once:', firstErr);
        raw = await callLLM(system, user, 500);
    }
    return { positive: sanitizeBuilderOutput(raw, style), style };
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

async function generateWithBackend(positive, negative) {
    switch (settings.backend) {
        case 'runware': return generateRunware(positive, negative);
        case 'novelai': return generateNovelAI(positive, negative);
        default: return generatePollinations(positive, negative);
    }
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
        const { positive: built, style } = await buildScenePrompt(mesId);
        const positive = composePositive(built, style);
        const negative = String(settings.negativePrompt || '').trim();
        console.log(`[SceneSnap] prompt (${style}):`, positive);

        const result = await generateWithBackend(positive, negative);
        const base64 = result.isUrl ? await urlToBase64(result.data) : result.data;

        // Re-fetch context: chat may have advanced while we generated.
        const ctx2 = getContext();
        const msg = ctx2.chat?.[mesId];
        if (!msg) throw new Error('Message no longer exists (chat changed?)');

        const subFolder = String(ctx2.name2 || 'SceneSnap');
        const fileName = `snap_${mesId}_${Date.now()}`;
        const url = await saveBase64AsFile(base64, subFolder, fileName, result.format || 'png');

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

// ------------------------------------------------------------------ cast auto-build

async function autoBuildCast() {
    const ctx = getContext();
    const excerpt = (ctx.chat || [])
        .filter(m => m && !m.is_system)
        .slice(-24)
        .map(m => `${m.name}: ${String(m.mes || '').slice(0, 1500)}`)
        .join('\n\n');
    if (!excerpt) {
        toastr.warning('Chat is empty', 'SceneSnap');
        return;
    }

    const $btn = $('#snapshot_cast_build');
    $btn.addClass('disabled');
    try {
        const user = `EXISTING SHEET (skip these characters):\n${getActiveCastSheet() || '(empty)'}\n\nCHAT EXCERPT:\n${excerpt}`;
        const raw = await callLLM(CAST_SYSTEM_PROMPT, user, 700);
        const cleaned = String(raw)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^[^:]{1,40}:\s?.+/.test(l) && !/^(existing|chat|sheet|example|name)\b/i.test(l))
            .join('\n');
        if (!cleaned || /^NONE$/i.test(cleaned.trim())) {
            toastr.info('No new characters found', 'SceneSnap');
            return;
        }
        const cast = getActiveCastName();
        settings.casts[cast] = `${String(settings.casts[cast] || '').trim()}\n${cleaned}`.trim();
        saveSettingsDebounced();
        $('#snapshot_cast_sheet').val(settings.casts[cast]);
        toastr.success('Cast sheet updated — review and edit it', 'SceneSnap');
    } catch (err) {
        notifyError(err);
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
                <label class="checkbox_label"><input id="snapshot_auto" type="checkbox"><span>Auto-illustrate new AI messages</span></label>

                <label for="snapshot_backend">Image backend</label>
                <select id="snapshot_backend" class="text_pole">
                    <option value="pollinations">Pollinations (free, natural-language)</option>
                    <option value="runware">Runware (Civitai anime checkpoints, tags)</option>
                    <option value="novelai">NovelAI (uses ST NovelAI key, tags)</option>
                </select>

                <div id="snapshot_runware_block" class="snapshot_backend_block">
                    <label for="snapshot_runware_key">Runware API key</label>
                    <input id="snapshot_runware_key" type="password" class="text_pole" placeholder="rw-..." autocomplete="off">
                    <label for="snapshot_runware_model">Model (AIR from Civitai sidebar)</label>
                    <input id="snapshot_runware_model" type="text" class="text_pole" placeholder="civitai:XXXXXX@XXXXXXX">
                    <div class="flex-container">
                        <div class="flex1"><label for="snapshot_runware_steps">Steps</label><input id="snapshot_runware_steps" type="number" min="1" max="60" class="text_pole"></div>
                        <div class="flex1"><label for="snapshot_runware_cfg">CFG</label><input id="snapshot_runware_cfg" type="number" min="1" max="15" step="0.5" class="text_pole"></div>
                    </div>
                    <label for="snapshot_runware_scheduler">Scheduler (blank = model default)</label>
                    <input id="snapshot_runware_scheduler" type="text" class="text_pole" placeholder="e.g. Euler a">
                </div>

                <div id="snapshot_novelai_block" class="snapshot_backend_block">
                    <label for="snapshot_nai_model">NovelAI model</label>
                    <select id="snapshot_nai_model" class="text_pole">
                        <option value="nai-diffusion-4-5-full">NAI Diffusion V4.5 Full</option>
                        <option value="nai-diffusion-4-5-curated">NAI Diffusion V4.5 Curated</option>
                        <option value="nai-diffusion-3">NAI Diffusion V3</option>
                    </select>
                    <div class="flex-container">
                        <div class="flex1"><label for="snapshot_nai_steps">Steps (≤28)</label><input id="snapshot_nai_steps" type="number" min="1" max="28" class="text_pole"></div>
                        <div class="flex1"><label for="snapshot_nai_scale">Scale</label><input id="snapshot_nai_scale" type="number" min="1" max="10" step="0.5" class="text_pole"></div>
                    </div>
                </div>

                <div id="snapshot_pollinations_block" class="snapshot_backend_block">
                    <label for="snapshot_poll_model">Pollinations model</label>
                    <input id="snapshot_poll_model" type="text" class="text_pole" placeholder="flux">
                </div>

                <label for="snapshot_size">Image size</label>
                <select id="snapshot_size" class="text_pole">
                    <option value="portrait">Portrait 832×1216</option>
                    <option value="landscape">Landscape 1216×832</option>
                    <option value="square">Square 1024×1024</option>
                </select>

                <hr>
                <label for="snapshot_profile">Prompt builder LLM (Connection Manager profile)</label>
                <select id="snapshot_profile" class="text_pole"></select>
                <label for="snapshot_style">Prompt style</label>
                <select id="snapshot_style" class="text_pole">
                    <option value="auto">Auto (match backend)</option>
                    <option value="tags">Danbooru tags</option>
                    <option value="natural">Natural language</option>
                </select>
                <label for="snapshot_forced">Always-append quality tags</label>
                <textarea id="snapshot_forced" class="text_pole textarea_compact" rows="2"></textarea>
                <label for="snapshot_negative">Negative prompt</label>
                <textarea id="snapshot_negative" class="text_pole textarea_compact" rows="2"></textarea>
                <label for="snapshot_extra_rules">Extra builder rules (optional)</label>
                <textarea id="snapshot_extra_rules" class="text_pole textarea_compact" rows="2" placeholder="e.g. Only ever depict up to 2 characters"></textarea>
                <label for="snapshot_strip">Strip from scene before building (regex, one per line)</label>
                <textarea id="snapshot_strip" class="text_pole textarea_compact" rows="3"></textarea>

                <hr>
                <label>Character cast (appearance sheets, one per line: <code>Name: tags</code>)</label>
                <div class="flex-container">
                    <select id="snapshot_cast_select" class="text_pole flex1"></select>
                    <div id="snapshot_cast_new" class="menu_button menu_button_icon fa-solid fa-plus" title="New cast"></div>
                    <div id="snapshot_cast_delete" class="menu_button menu_button_icon fa-solid fa-trash" title="Delete cast"></div>
                </div>
                <textarea id="snapshot_cast_sheet" class="text_pole textarea_compact" rows="6" placeholder="Jovan: boy, short black hair, red eyes, tall, lean build, academy uniform"></textarea>
                <div class="flex-container">
                    <div id="snapshot_cast_build" class="menu_button">Auto-build cast from chat</div>
                    <div id="snapshot_test" class="menu_button">Test backend</div>
                    <div id="snapshot_reset" class="menu_button">Reset defaults</div>
                </div>
                <small>The active cast is remembered per chat. /snap illustrates the last AI message.</small>
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
    $('#snapshot_backend').val(settings.backend);
    $('#snapshot_size').val(settings.sizePreset);
    $('#snapshot_style').val(settings.promptStyle);
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
    $('#snapshot_backend').on('change', function () { settings.backend = this.value; toggleBackendBlocks(); saveSettingsDebounced(); });
    $('#snapshot_size').on('change', function () { settings.sizePreset = this.value; saveSettingsDebounced(); });
    $('#snapshot_style').on('change', function () { settings.promptStyle = this.value; saveSettingsDebounced(); });
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
    $('#snapshot_cast_build').on('click', autoBuildCast);

    $('#snapshot_test').on('click', async function () {
        const $btn = $(this);
        $btn.addClass('disabled');
        try {
            const style = resolveStyle();
            const positive = style === 'tags'
                ? '1girl, silver hair, long hair, blue eyes, smile, portrait, simple background, masterpiece, best quality'
                : 'Anime illustration. A close-up portrait of a smiling girl with long silver hair and blue eyes against a simple soft background.';
            const t0 = Date.now();
            const result = await generateWithBackend(positive, String(settings.negativePrompt || ''));
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

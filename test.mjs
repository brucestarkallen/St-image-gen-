// SceneSnap gate harness. Extracts pure top-level functions from index.js
// (line-based: from `function name(` / `async function name(` at column 0 to the
// first following `}` at column 0) into a sandbox module, then asserts behavior.
// SS_SRC overrides the source path — used to negative-test guards against a
// deliberately broken scratch copy (must exit 1). Run: node test.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SRC = process.env.SS_SRC || new URL('./index.js', import.meta.url).pathname;
const src = readFileSync(SRC, 'utf-8');
const lines = src.split('\n');

function extract(name) {
    const startRe = new RegExp(`^(async )?function ${name}\\(`);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (startRe.test(lines[i])) { start = i; break; }
    }
    if (start === -1) throw new Error(`extract: function ${name} not found`);
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
    }
    throw new Error(`extract: function ${name} has no column-0 closer`);
}

const FUNCS = [
    'normalizeForMatch', 'sanitizeBubbles', 'sanitizeBuilderOutput', 'softSanitize',
    'parsePanels', 'parseCastSheet', 'mergeCastLines', 'effectiveForcedTags',
    'composePositive', 'scanPresenceIn', 'markerDetails', 'ledgerStateLines',
    'stripScene', 'explainError', 'isStaleSession', 'stripLayoutMeta', 'appendAnchor', 'mineDressTags', 'normalizeCountTags', 'filterRankGarments', 'assembleIdentity', 'scrubState', 'getSize',
];

const prelude = `
const defaultSettings = Object.freeze({
    forcedTags: 'masterpiece, best quality, absurdres, detailed background',
    negativePrompt: 'lowres',
    stripPatterns: '<details>[\\\\s\\\\S]*?</details>\\n\\\\{[A-Z_]+\\\\}[\\\\s\\\\S]*?\\\\{/[A-Z_]+\\\\}\\n<!--[\\\\s\\\\S]*?-->',
});
const BACKEND_QUALITY = { novelai: 'very aesthetic, masterpiece, no text, detailed background' };
const SIZE_PRESETS = { portrait: { width: 832, height: 1216 }, landscape: { width: 1216, height: 832 }, square: { width: 1024, height: 1024 } };
let settingsSizeRef;
let settings = {
    forcedTags: defaultSettings.forcedTags,
    backend: 'runware',
    stripPatterns: defaultSettings.stripPatterns,
};
export function _setSettings(patch) { Object.assign(settings, patch); }
`;

const sandboxPath = '/tmp/ss_sandbox_' + process.pid + '.mjs';
writeFileSync(sandboxPath, prelude + '\n' + FUNCS.map(extract).join('\n\n')
    + `\nexport { ${FUNCS.join(', ')} };\n`);
const S = await import(pathToFileURL(sandboxPath).href);

let pass = 0, fail = 0;
function check(label, cond) {
    if (cond) { pass++; }
    else { fail++; console.error('FAIL:', label); }
}
function eq(label, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; }
    else { fail++; console.error('FAIL:', label, '\n  got: ', g, '\n  want:', w); }
}

// ---------------------------------------------------------------- fixtures
const SCENE = `Mari wiped the grease from her hands. "Supplies at the threshold." She glanced back.
Jovan didn't look up. "Our household specializes in iatrogenic damage," he said, sorting the stove's miserable contents.
[IST: Mari|kneeling by the stove, grease-streaked apron] [IST: Jovan|sorting supplies, sleeves rolled] [ACW: Rex|away at the market]`;

// ---------------------------------------------------------------- normalizeForMatch
check('normalize: curly quotes + case + whitespace',
    S.normalizeForMatch('  \u201CSupplies\u2019   AT the\tthreshold\u201D ') === '"supplies\' at the threshold"');

// ---------------------------------------------------------------- sanitizeBubbles (verbatim guarantee)
{
    const good = S.sanitizeBubbles([
        { speaker: 'Mari', text: '\u201CSupplies at the threshold.\u201D' },
        { speaker: 'Jovan', text: 'Our household specializes in iatrogenic damage,' },
    ], SCENE);
    eq('bubbles: two verbatim lines pass (curly quotes stripped, punctuation kept)',
        good.map(b => b.speaker), ['Mari', 'Jovan']);
    check('bubbles: text preserved verbatim', good[0].text === 'Supplies at the threshold.');

    const invented = S.sanitizeBubbles([
        { speaker: 'Mari', text: 'This line was never spoken anywhere.' },
        { speaker: 'Jovan', text: 'Our household specializes in iatrogenic damage' },
    ], SCENE);
    eq('bubbles: invented line dropped, real line kept', invented.map(b => b.speaker), ['Jovan']);

    const capped = S.sanitizeBubbles([
        { speaker: 'A', text: 'Supplies at the threshold.' },
        { speaker: 'B', text: 'Our household specializes in iatrogenic damage' },
        { speaker: 'C', text: 'She glanced back.' },
    ], SCENE);
    check('bubbles: hard cap 2 per panel', capped.length === 2);

    const ellipsis = S.sanitizeBubbles([{ speaker: 'M', text: 'Supplies at the threshold\u2026' }], SCENE);
    check('bubbles: trailing ellipsis stripped, then verbatim-matched', ellipsis.length === 1);

    const longScene = 'He said "' + 'alpha beta gamma delta '.repeat(10) + 'end" and left.';
    const longText = ('alpha beta gamma delta '.repeat(10) + 'end').trim();
    const trimmed = S.sanitizeBubbles([{ speaker: 'X', text: longText }], longScene);
    check('bubbles: verify-then-trim — sentence-less overflow word-cut with visible ellipsis',
        trimmed.length === 1 && trimmed[0].text.length <= 105 && trimmed[0].text.endsWith('\u2026'));

    // The exact field defect: a ~95-char sentence must ship WHOLE, never chopped mid-phrase.
    const line95 = "But don't worry. After my official proclamation, we'll have a Thirteenth Division celebration.";
    const whole = S.sanitizeBubbles([{ speaker: 'J', text: line95 }], 'He said: ' + line95 + ' And smiled.');
    check('bubbles: 95-char sentence ships whole (no mid-sentence chop)',
        whole.length === 1 && whole[0].text === line95);

    // Overflow WITH a sentence boundary: cut lands exactly on the boundary, no ellipsis needed.
    const sA = 'The first sentence is exactly this long and it ends right here.'; // 63 chars incl. period
    const sB = 'The second sentence keeps going for quite a while longer than the window allows.';
    const cutAtSentence = S.sanitizeBubbles([{ speaker: 'N', text: sA + ' ' + sB }], sA + ' ' + sB);
    check('bubbles: overflow cuts at the sentence boundary',
        cutAtSentence.length === 1 && cutAtSentence[0].text === sA);

    check('bubbles: empty scene yields nothing (no unverifiable text ever renders)',
        S.sanitizeBubbles([{ speaker: 'M', text: 'anything' }], '').length === 0);
    check('bubbles: non-array tolerated', S.sanitizeBubbles(null, SCENE).length === 0);
}

// ---------------------------------------------------------------- parsePanels
{
    // Legacy single-line path (bubbles off, 1 panel) — behavior lock.
    const legacy = S.parsePanels('Here you go:\n1girl, red eyes, alley, night, rain\nHope that helps!', 'tags', 1);
    check('parse: legacy line mode picks tag-dense line, shape {prompt,bubbles}',
        legacy.length === 1 && legacy[0].prompt.startsWith('1girl') && Array.isArray(legacy[0].bubbles) && legacy[0].bubbles.length === 0);

    // JSON single panel with bubbles: invented line filtered, verbatim kept.
    const jsonSingle = S.parsePanels(JSON.stringify({
        panels: [{ prompt: '1boy, 1girl, kitchen, stove, grease', bubbles: [
            { speaker: 'Mari', text: 'Supplies at the threshold.' },
            { speaker: 'Mari', text: 'Totally invented dialogue here.' },
        ] }],
    }), 'tags', 1, { bubbles: true, sceneText: SCENE });
    check('parse: JSON single panel, verbatim filter applied inside',
        jsonSingle.length === 1 && jsonSingle[0].bubbles.length === 1 && jsonSingle[0].bubbles[0].text === 'Supplies at the threshold.');

    // NEGATIVE: bubbles=false must never emit bubbles even when the JSON has them.
    const gated = S.parsePanels(JSON.stringify({
        panels: [{ prompt: '1girl, alley', bubbles: [{ speaker: 'M', text: 'Supplies at the threshold.' }] }],
    }), 'tags', 2, { bubbles: false, sceneText: SCENE });
    check('parse: bubble gating — setting off strips bubbles from output', gated[0].bubbles.length === 0);

    // Panel cap.
    const many = S.parsePanels(JSON.stringify({
        panels: Array.from({ length: 7 }, (_, i) => ({ prompt: `panel ${i}, 1girl, tags` })),
    }), 'tags', 4, { bubbles: false });
    check('parse: panel hard cap honored', many.length === 4);

    // Truncated JSON recovery: prompts recovered, bubbles dropped (never fabricated).
    const truncated = '{"panels":[{"prompt":"1girl, rooftop, night, wind","bubbles":[{"speaker":"M","text":"Supplies at the threshold."}]},{"prompt":"1boy, stairwell, torch';
    const rec = S.parsePanels(truncated, 'tags', 3, { bubbles: true, sceneText: SCENE });
    check('parse: truncated JSON recovers completed prompts with zero bubbles',
        rec.length === 1 && rec[0].prompt.includes('rooftop') && rec[0].bubbles.length === 0);

    // <think> stripping still holds.
    const think = S.parsePanels('<think>reasoning about it</think>\n1girl, garden, sunset, tags, more', 'tags', 1);
    check('parse: think-block stripped', !think[0].prompt.includes('reasoning'));
}

// ---------------------------------------------------------------- presence markers
{
    const ON = '\\[IST:\\s*([^|\\]]+)';
    const OFF = '\\[ACW:\\s*([^|\\]]+)';
    const p = S.scanPresenceIn(SCENE, ON, OFF);
    eq('presence: IST names captured in order, trimmed', p.present, ['Mari', 'Jovan']);
    eq('presence: ACW names captured', p.absent, ['Rex']);

    const dup = S.scanPresenceIn('[IST: Mari|a] [IST: mari|b] [IST: Jovan|c]', ON, OFF);
    eq('presence: case-insensitive dedupe', dup.present, ['Mari', 'Jovan']);

    const custom = S.scanPresenceIn('<<ON: Stella>> [IST: Mari|x]', '<<ON:\\s*([^>]+)>>', OFF);
    eq('presence: custom pattern replaces default, not merged', custom.present, ['Stella']);

    eq('presence: invalid custom pattern degrades to empty, no throw',
        S.scanPresenceIn(SCENE, '([', OFF).present, []);

    const d = S.markerDetails(SCENE);
    check('presence: marker detail after pipe captured',
        d['mari'].detail === 'kneeling by the stove, grease-streaked apron' && d['jovan'].detail === 'sorting supplies, sleeves rolled');
}

// ---------------------------------------------------------------- ledger state lines
{
    const ledger = {
        Mari: { state: 'In the safehouse kitchen,   kneeling by the stove; wary but focused.', core: 'x' },
        Jovan: { state: '' },
        Rex: { state: 'At the market across town, haggling.' },
        Stella: { core: 'no state field' },
    };
    const withNames = S.ledgerStateLines(ledger, ['mari', 'Jovan'], '');
    eq('ledger: case-insensitive key match, empty state skipped',
        withNames, ['Mari: In the safehouse kitchen, kneeling by the stove; wary but focused.']);

    const markerless = S.ledgerStateLines(ledger, [], 'mari wiped the grease. rex was mentioned once.');
    eq('ledger: markerless mode requires scene mention',
        markerless.map(l => l.split(':')[0]), ['Mari', 'Rex']);

    const long = { A: { state: 'x'.repeat(500) } };
    check('ledger: state truncated to 260', S.ledgerStateLines(long, ['A'], '')[0].length <= 260 + 3);

    const big = {};
    for (let i = 0; i < 10; i++) big['C' + i] = { state: 'present here' };
    check('ledger: cap 6 lines', S.ledgerStateLines(big, Object.keys(big), '').length === 6);

    check('ledger: null ledger tolerated', S.ledgerStateLines(null, ['A'], '').length === 0);
}

// ---------------------------------------------------------------- stripScene
{
    S._setSettings({ stripPatterns: '<details>[\\s\\S]*?</details>\n\\{[A-Z_]+\\}[\\s\\S]*?\\{/[A-Z_]+\\}\n<!--[\\s\\S]*?-->' });
    const stripped = S.stripScene('<details>tracker junk</details>\nProse beat one.\n{STATS}HP 4{/STATS}\n<!-- hidden -->\nFinal beat.');
    check('strip: details/tracker/comment blocks removed, prose kept',
        stripped === 'Prose beat one.\n\nFinal beat.' || stripped === 'Prose beat one.\nFinal beat.');
    S._setSettings({ stripPatterns: '([' });
    check('strip: invalid pattern skipped without throwing', S.stripScene('text stays') === 'text stays');
    S._setSettings({ stripPatterns: defaultPatterns() });
}
function defaultPatterns() { return '<details>[\\s\\S]*?</details>\n\\{[A-Z_]+\\}[\\s\\S]*?\\{/[A-Z_]+\\}\n<!--[\\s\\S]*?-->'; }

// ---------------------------------------------------------------- behavior locks (pre-existing)
{
    eq('lock: parseCastSheet', S.parseCastSheet('Jovan: boy, black hair\n\nbadline\nMari: girl, apron'),
        [{ name: 'Jovan', tags: 'boy, black hair' }, { name: 'Mari', tags: 'girl, apron' }]);

    check('lock: mergeCastLines dedupes by name case-insensitively',
        S.mergeCastLines('Mari: a\nJovan: b', 'mari: XXX\nStella: c') === 'Mari: a\nJovan: b\nStella: c');

    S._setSettings({ forcedTags: 'masterpiece, best quality', backend: 'runware' });
    check('lock: composePositive dedupes forced tags',
        S.composePositive('1girl, masterpiece, alley', 'tags') === '1girl, masterpiece, alley, best quality');

    check('lock: sanitizeBuilderOutput strips fences and think blocks',
        S.sanitizeBuilderOutput('<think>x</think>```\n1girl, red eyes, alley, night\n```', 'tags') === '1girl, red eyes, alley, night');
}

// ---------------------------------------------------------------- fetch-failure translation
{
    check('explain: Chrome fetch failure names ST, not the raw error',
        /SillyTavern/.test(S.explainError('Failed to fetch')) && !/Failed to fetch/.test(S.explainError('Failed to fetch')));
    check('explain: Firefox wording translated',
        /SillyTavern/.test(S.explainError('NetworkError when attempting to fetch resource.')));
    check('explain: Safari wording translated', /SillyTavern/.test(S.explainError('Load failed')));
    check('explain: real backend errors pass through untouched',
        S.explainError('NovelAI multi-char: 500 upstream oops') === 'NovelAI multi-char: 500 upstream oops');
    check('explain: empty tolerated', S.explainError(null) === '');
}

// ---------------------------------------------------------------- world anchor stamping
{
    check('anchor: appended without duplicating existing tokens',
        S.appendAnchor('1girl, barracks courtyard, snow', 'barracks courtyard, black kimono, snow, white sash')
            === '1girl, barracks courtyard, snow, black kimono, white sash');
    check('anchor: empty anchor is a no-op', S.appendAnchor('1boy, smile', '') === '1boy, smile');
    check('anchor: case-insensitive dedupe', S.appendAnchor('1girl, Black Kimono', 'black kimono') === '1girl, Black Kimono');

    const cast = 'Jovan Oda: man, medium white hair, black kosode, no insignia\nRukia Kuchiki: woman, violet eyes, shinigami uniform, lieutenant armband\nShunsui: man, pink flowered kimono, captain haori, eyepatch';
    const mined = S.mineDressTags(cast);
    check('mine: garment tags collected, non-garments excluded',
        mined.includes('black kosode') && mined.includes('shinigami uniform')
        && mined.includes('pink flowered kimono') && !/violet eyes|white hair|eyepatch/.test(mined));
    check('mine: rank garments never become world dress (the haori-on-everyone field bug)',
        !/captain haori|lieutenant armband/.test(mined));
    check('mine: names never leak (only post-colon tags scanned)', !/Jovan|Rukia|Shunsui/.test(mined));
    check('mine: empty cast tolerated', S.mineDressTags('') === '');
}

// ---------------------------------------------------------------- CJK leak scrub
{
    check('cjk: native-language leak stripped from tag prompts (the field 脚印 bug)',
        S.sanitizeBuilderOutput('1boy, walking, trail of脚印 in sand, dust', 'tags') === '1boy, walking, trail of in sand, dust');
    check('cjk: pure-english prompts untouched',
        S.sanitizeBuilderOutput('1girl, snow, courtyard', 'tags') === '1girl, snow, courtyard');
}

// ---------------------------------------------------------------- state scrub enforcement
{
    const block = 'man, long black spiked hair, bells in hair, eyepatch, facial scar, towering muscular build, tattered captain haori';
    // The exact field echo: real state + full identity duplicate + mid-word fragment.
    const echoed = 'kneeling, bleeding, shredded forearms, coughing blood, delirious smile, tattered captain haori, long black spiked hair, bells in hair, eyepatch, facial scar, towering mus';
    const clean = S.scrubState(echoed, block);
    check('scrub: echoed identity tokens deleted, true state kept',
        clean === 'kneeling, bleeding, shredded forearms, coughing blood, delirious smile');
    check('scrub: mid-word fragments (prefix of a block token) deleted', !clean.includes('towering'));
    check('scrub: cap is tag-safe — never cuts inside a tag',
        S.scrubState(Array.from({length: 40}, (_, i) => `tag number ${i}`).join(', '), block).split(', ').every(x => /^tag number \d+$/.test(x)));
    check('scrub: empty state passes through', S.scrubState('', block) === '');
    check('scrub: welded via assembleIdentity — no doubled identity in the final run',
        (() => {
            const run = S.assembleIdentity([{ name: 'Z', state: echoed }], 'Z: ' + block).blocks[0];
            return run.split(', ').filter(x => x === 'eyepatch').length === 1 && !run.split(', ').includes('towering mus');
        })());
}

// ---------------------------------------------------------------- code-written identity
{
    const sheet = 'Jovan Oda: man, medium white hair, pale blue eyes, black kosode, no insignia\nRukia Kuchiki: woman, short black hair, violet eyes, shinigami uniform\nKenpachi Zaraki: man, long black spiked hair, bells in hair, eyepatch, towering muscular build\nIsane Kotetsu: woman, short silver hair, grey eyes, tall, captain haori';

    const duo = S.assembleIdentity([
        { name: 'Isane Kotetsu', state: 'kneeling beside him, glowing green hands on his chest, fierce expression' },
        { name: 'Kenpachi Zaraki', state: 'kneeling in crater, shredded forearms, laughing' },
    ], sheet);
    check('identity: state welds into its owner\'s contiguous run — the laugh cannot migrate',
        duo.counts === '1boy, 1girl'
        && duo.blocks[0] === 'woman, short silver hair, grey eyes, tall, captain haori, kneeling beside him, glowing green hands on his chest, fierce expression'
        && duo.blocks[1] === 'man, long black spiked hair, bells in hair, eyepatch, towering muscular build, kneeling in crater, shredded forearms, laughing'
        && duo.missing.length === 0);
    check('identity: legacy string who entries still work',
        S.assembleIdentity(['Jovan Oda'], sheet).blocks[0].startsWith('man, medium white hair'));

    const trio = S.assembleIdentity([
        { name: 'Jovan Oda', state: 'standing' }, { name: 'Rukia Kuchiki', state: '' }, { name: 'Isane Kotetsu', state: 'running' },
    ], sheet);
    check('identity: three-plus get placement tags after state, in who order',
        trio.blocks[0].endsWith('standing, foreground left') && trio.blocks[1].endsWith(', center') && trio.blocks[2].endsWith('running, foreground right'));

    const bad = S.assembleIdentity([{ name: 'Elderly Stranger', state: 'watching' }, 'Jovan Oda'], sheet);
    check('identity: unknown names reported, never invented',
        bad.missing.length === 1 && bad.missing[0] === 'Elderly Stranger' && bad.blocks.length === 1);
    check('identity: empty who tolerated', S.assembleIdentity([], sheet).counts === '');
}

// ---------------------------------------------------------------- count-tag normalization
{
    check('counts: stacked alternatives collapse to first-of-class (the field 2boys,1boy,1other bug)',
        S.normalizeCountTags('2boys, 1boy, 1other, man, white hair, sword') === '2boys, 1other, man, white hair, sword');
    check('counts: non-danbooru gender words canonicalized', S.normalizeCountTags('1man, 1woman, tall, scar') === '1boy, 1girl, tall, scar');
    check('counts: prompts without leading counts untouched',
        S.normalizeCountTags('wide shot, 1boy, smile') === 'wide shot, 1boy, smile');

    check('rank-filter: haori and armband never survive into the anchor',
        S.filterRankGarments('shihakusho, kosode, captain haori, hakama, lieutenant armband') === 'shihakusho, kosode, hakama');
    check('rank-filter: empty and clean lists pass through',
        S.filterRankGarments('') === '' && S.filterRankGarments('black kimono, sash') === 'black kimono, sash');
}

// ---------------------------------------------------------------- layout-meta scrub
{
    const leaked = 'comic strip, 4 panels, vertical layout, panel 1: wide shot, 1boy, medium white hair, black kosode, crowd, barracks courtyard';
    const clean = S.stripLayoutMeta(leaked);
    check('layout: leaked page language scrubbed, scene tags intact',
        !/comic|panel|layout/i.test(clean) && clean.includes('wide shot, 1boy, medium white hair') && clean.includes('barracks courtyard'));
    check('layout: normal prompts untouched',
        S.stripLayoutMeta('1girl, short black hair, violet eyes, courtyard, snow') === '1girl, short black hair, violet eyes, courtyard, snow');
    check('layout: multiple views and manga page variants scrubbed',
        !/multiple views|manga page|4koma/i.test(S.stripLayoutMeta('multiple views, manga page, 4koma, 1boy, smile')));
}

// ---------------------------------------------------------------- stale-session guard
{
    const LIVE_403 = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>ForbiddenError: Invalid CSRF token. Please refresh the page and try again.</pre>\n</body>\n</html>\n';
    check('stale: live ST 403 body detected', S.isStaleSession(403, LIVE_403));
    check('stale: other 403s not misclassified', !S.isStaleSession(403, 'Forbidden: whitelist'));
    check('stale: marker without 403 not misclassified', !S.isStaleSession(500, LIVE_403));
    check('stale: empty tolerated', !S.isStaleSession(403, ''));
}

// ---------------------------------------------------------------- source-level invariants
{
    check('src: single-panel bubble mode requests strict JSON', src.includes('exactly one panel'));
    check('src: overlay failures ship the clean panel', src.includes('bubble overlay failed, shipping the clean panel'));
    check('src: no direct cross-origin fetch to NovelAI remains',
        !src.includes("fetch('https://image.novelai.net"));
    check('src: strip panels generate landscape (flag threaded to every panel backend)',
        src.includes('generateWithBackend(finals[i], negative, panels.length > 1, runSeed)')
        && src.includes('generateRunware(positive, negative, landscape, seed)')
        && src.includes('generateNovelAI(positive, negative, landscape, seed)')
        && src.includes('generatePollinations(positive, negative, landscape, seed)')
        && src.includes('if (landscape && p.height > p.width)'));
    check('src: dialogue spreads one-per-panel by default', src.includes('Prefer ONE line per panel'));
    check('src: one seed per strip — threaded through dispatch and all three backends',
        src.includes('generateWithBackend(finals[i], negative, panels.length > 1, runSeed)')
        && src.includes('generateRunware(positive, negative, landscape, seed)')
        && src.includes('seed: Number.isInteger(seed) ? seed : -1,')
        && src.includes('seed: Number.isInteger(seed) ? seed : undefined,')
        && src.includes('Number.isInteger(seed) ? seed : Math.floor'));
    check('src: stitch is a rigid cover-filled grid with framed cells',
        src.includes('cx.drawImage(img2, sx, sy, sw, sh, gutter, y, cellW, cellH)') && src.includes('cx.strokeRect(gutter + 2'));
    check('src: world derived once as data and stamped onto every panel by code',
        src.includes('"setting":"<location/environment/population tags') && src.includes('appendAnchor(p.prompt, anchor)')
        && src.includes('mineDressTags(getActiveCastSheet())'));
    check('src: public address is speaker + attending group, never a private two-shot',
        src.includes('never a private two-shot for a public address'));
    check('src: panel discipline — chronology+climax, continuity, both parties via who, four-cap, role-word ban, speaker orientation',
        src.includes('MUST be one of the panels') && src.includes('strict chronological order')
        && src.includes("carry the previous panel's consequences forward")
        && src.includes('BOTH parties in "who"')
        && src.includes('up to FOUR; fold extras into the crowd')
        && src.includes('jobs, not outfits')
        && src.includes('oriented toward whoever they address'));
    check('src: explicit scenes are tagged explicitly, anatomy locked to cast sheet',
        src.includes('EXPLICIT SCENES:') && src.includes('never euphemize') && src.includes('fullSystem += NSFW_RULE;'));
    check('src: state purity is enforced in code, not requested',
        src.includes('function scrubState(') && src.includes('scrubState(state, hit.tags)'));
    check('src: state is bound to its owner by schema and weld',
        src.includes('"state":"<THIS character') && src.includes('welds their state onto it')
        && src.includes("carries it in their OWN \"state\"")
        && src.includes('scrubState(state, hit.tags) ? `${hit.tags}, ${scrubState(state, hit.tags)}`'));
    check('src: setting and dress are tag-capped in code',
        src.includes('capTags(obj?.setting, 12)') && src.includes('capTags(obj?.dress, 8)'));
    check('src: the cast author copies canon verbatim — no synonyms, adults are man/woman',
        src.includes('COPY, never compose') && src.includes("never 'badge'")
        && src.includes("ONLY for characters the story marks as children"));
    check('src: every chat seeds its new characters append-only, no emptiness gate',
        src.includes('Every chat seeds its own NEW characters once') && !src.includes('settings.autoCast && !getActiveCastSheet()'));
    check('src: every generation self-identifies — engine version + cast provenance in the debug record',
        src.includes('`ENGINE v${VERSION}`')
        && src.includes('CAST — "${getActiveCastName()}"')
        && src.includes('engine: VERSION,')
        && src.includes('v${esc(lastDebug.engine'));
    check('src: who schema is enforced with one corrective retry and surfaced in the debug popup',
        src.includes('PREVIOUS OUTPUT REJECTED: every panel MUST include the "who" array')
        && src.includes('whoCoverage(panels2) > whoCoverage(panels)')
        && src.includes('(builder ignored the who schema)'));
    check('src: contract v5.1 — who owns identity AND state; builder writes neither identity nor per-character detail into the shared prompt',
        src.includes('WHO writes identity AND owns state, and WHO is not you')
        && src.includes('one contiguous run per character')
        && src.includes('a climax panel whose victim is missing from "who" is a failed panel')
        && src.includes('assembleIdentity(p.who, activeSheet)')
        && src.includes('Never blend two people into one')
        && src.includes('never render anyone as a child unless their cast tags say so'));
    check('src: scene population is setting-state with continuity',
        src.includes('standing population') && src.includes('established spectators never vanish'));
    check('src: skin tone locked to cast tags across panels',
        src.includes('may never change complexion between panels'));
    check('src: counts normalized and anchor rank-filtered in code, not just by contract',
        src.includes('normalizeCountTags(softSanitize(') && src.includes('filterRankGarments(panels.dress)'));
    check('src: dress field excludes rank garments by contract',
        src.includes('never rank- or status-specific garments'));
    check('src: panel prompts are single frames by contract (rule + scrub wired)',
        src.includes('never write layout words') && src.includes('stripLayoutMeta(t.replace'));
    check('src: SceneSnap media renders full-bleed and survives reloads',
        src.includes("scenesnap: true,") && src.includes('markSceneSnapMedia') && src.includes("$mes.addClass('scenesnap-media')"));
    check('src: the outfit contract is verbatim per panel',
        src.includes('never change outfits, hair, or colors between panels'));
    check('src: sequence mode floors at 2 panels — the strip is guaranteed',
        src.includes('(2 to ${maxPanels})') && src.includes('Never fewer than 2 panels'));
    check('src: two bubbles sit side-by-side in the top band, never stacked down the frame',
        src.includes('W * 0.36') && !src.includes('cursorY += bh'));
    check('src: generateRaw fallback precedes quiet prompt',
        src.indexOf('ctx.generateRaw') !== -1 && src.indexOf('ctx.generateRaw') < src.indexOf('ctx.generateQuietPrompt'));
    check('src: multi-char fully removed — no NAI direct/proxy transport, no token setting, no latch',
        !/naiMultiChar|naiToken|MULTICHAR|NAI_IMAGE_ENDPOINT|extractFirstPngFromZip|classifyFetchDeath|probeServerUp/.test(src));
    check('src: version stamp matches manifest', (() => {
        const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf-8'));
        const m = src.match(/const VERSION = '([^']+)'/);
        return m && m[1] === manifest.version;
    })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

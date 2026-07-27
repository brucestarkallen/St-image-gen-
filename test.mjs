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
    'splitPrincipals', 'framesCrowd', 'enforceShotGrammar', 'hasGarment', 'firstGarmentTag', 'stripTransientFromSetting', 'capSentenceSafe', 'foldTagDiacritics',
    'stripRankInsignia', 'stripNameTags', 'parsePlan', 'validatePlan', 'beatWords', 'beatsAreTheSame',
    'normalizeForMatch', 'sanitizeBubbles', 'sanitizeBuilderOutput', 'softSanitize',
    'parsePanels', 'parseCastSheet', 'mergeCastLines', 'effectiveForcedTags',
    'composePositive', 'scanPresenceIn', 'markerDetails', 'ledgerStateLines',
    'stripScene', 'explainError', 'isStaleSession', 'stripLayoutMeta', 'appendAnchor', 'mineDressTags', 'normalizeCountTags', 'filterRankGarments', 'assembleIdentity', 'scrubState', 'seedForPanel', 'replaceNamesInSentence', 'capTagSafe', 'antiModernNegative', 'isPlaceholderTags', 'stripPlaceholderLines', 'getSize',
    'backgroundFigureTag', 'dedupeAgainstAnchor', 'neutralizeRoleUniforms', 'unifyStripLighting', 'applyUndress', 'hoistCrowdTokens', 'extractCrowdTokens', 'purgeModernRoles', 'panelLacksAnatomy', 'stripPersonalGarments', 'cleanWorldDress', 'countSceneBeats', 'dressForPanel', 'anatomyContinuity', 'scrubEchoedCounts', 'inferLyingFromPosition', 'mapLimit', 'explicitFramingGuard', 'extractSceneQuotes', 'attributeSpeaker', 'capBubbleText', 'anatomyFloor', 'openingBeatMissed',
];

const prelude = `
const defaultSettings = Object.freeze({
    forcedTags: 'masterpiece, best quality, absurdres, detailed background',
    negativePrompt: 'lowres',
    stripPatterns: '<details>[\\\\s\\\\S]*?</details>\\n\\\\{[A-Z_]+\\\\}[\\\\s\\\\S]*?\\\\{/[A-Z_]+\\\\}\\n<!--[\\\\s\\\\S]*?-->',
});
const BACKEND_QUALITY = { novelai: 'no text, detailed background' };
const SIZE_PRESETS = { portrait: { width: 832, height: 1216 }, landscape: { width: 1216, height: 832 }, square: { width: 1024, height: 1024 } };
let settingsSizeRef;
let settings = {
    forcedTags: defaultSettings.forcedTags,
    backend: 'runware',
    stripPatterns: defaultSettings.stripPatterns,
};
export function _setSettings(patch) { Object.assign(settings, patch); }
`;

// Top-level const helpers used by extracted functions (single-line, by name).
function extractConst(name) {
    const line = lines.find(l => l.startsWith(`const ${name} = `));
    if (!line) throw new Error(`extractConst: ${name} not found`);
    return line;
}
const CONSTS = ['escRe', 'BACKGROUND_STATE', 'CODE_OWNED_TAG', 'GARMENT_CONDITION', 'TRANSIENT_ACTIVITY', 'FRAMING_TAG', 'ANGLE_TAG', 'SIZE_WORD', 'SIZE_NOUN', 'GARMENT_WORDS', 'RANK_WORD', 'DECORATION_WORD', 'BEAT_STOPWORD', 'LIGHT_TOKEN', 'EXPLICIT_STATE', 'CROWD_ANCHOR_TOKEN', 'MODERN_ROLE', 'SEX_ACT', 'GENITAL_TAG', 'COUNT_TAG_ONLY', 'LYING_STATE', 'UNDER_PARTNER'];

const sandboxPath = '/tmp/ss_sandbox_' + process.pid + '.mjs';
writeFileSync(sandboxPath, prelude + '\n' + CONSTS.map(extractConst).join('\n') + '\n' + FUNCS.map(extract).join('\n\n')
    + `\nexport { ${FUNCS.join(', ')}, ${CONSTS.join(', ')} };\n`);
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

    // Hybrid sentence: captured, cleaned, capped.
    const withSentence = S.parsePanels(JSON.stringify({
        panels: [{ prompt: 'wide shot, dust', sentence: 'She kneels beside him at the crater\'s center, pressing both hands to his chest.', who: [] }],
    }), 'tags', 2, { bubbles: false });
    check('parse: composition sentence captured and cleaned',
        withSentence[0].sentence === "She kneels beside him at the crater's center, pressing both hands to his chest.");

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

    // NAI emphasis transport (0.24.0): quality PREPENDED like the website's own
    // qualityToggle, V4.5 negative emphasis on the tail — default field, tags style.
    {
        S._setSettings({ backend: 'novelai', forcedTags: 'masterpiece, best quality, absurdres, detailed background' });
        const out = S.composePositive('1boy, shouting, courtyard', 'tags');
        check('nai: NO quality block at all (0.28.0 user A/B — the prompt starts with the subject)',
            out.startsWith('1boy, shouting, courtyard') && !/very aesthetic|best quality|amazing quality/.test(out));
        check('nai: tail is functional only (0.29.0 — flat-color emphasis deleted by user A/B)',
            /no text, detailed background$/.test(out) && !/flat color|::/.test(out));
        check('nai: natural style keeps the classic append path',
            !S.composePositive('An anime illustration of a courtyard', 'natural').startsWith('{'));
        S._setSettings({ forcedTags: 'my custom tags' });
        check('nai: user-edited forcedTags bypass the emphasis transport',
            S.composePositive('1boy, shouting', 'tags') === '1boy, shouting, my custom tags');
        S._setSettings({ forcedTags: 'masterpiece, best quality, absurdres, detailed background', backend: 'runware' });
    }

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

// ---------------------------------------------------------------- placeholder = empty slot
{
    check('placeholder: detected', S.isPlaceholderTags('man, (appearance unknown — fill in)'));
    check('placeholder: real lines are not placeholders', !S.isPlaceholderTags('man, medium white hair, black kosode'));
    check('placeholder: stripped from sheets so the author re-outputs them',
        S.stripPlaceholderLines('A: man, tall\nB: girl, (appearance unknown — fill in)\nC: woman, glasses')
            === 'A: man, tall\nC: woman, glasses');
    const sheet = 'Kiyone: girl, (appearance unknown — fill in)\nJovan Oda: man, medium white hair';
    const r = S.assembleIdentity([{ name: 'Kiyone', state: 'running' }, 'Jovan Oda'], sheet);
    check('placeholder: counts as MISSING at assembly — junk never enters a prompt, seeding re-fires',
        r.missing.length === 1 && r.missing[0] === 'Kiyone' && r.blocks.length === 1 && !/appearance unknown/.test(r.blocks.join('|')));
}

// ---------------------------------------------------------------- sentence name scrub
{
    const sheet = 'Jovan Oda: man, medium white hair\nRukia Kuchiki: woman, short black hair\nKiyone Kotetsu: woman, short blonde hair';
    check('names: cast names become role words (full and partial)',
        S.replaceNamesInSentence('Rukia stands before Jovan while Kiyone runs past.', sheet)
            === 'the woman stands before the man while the woman runs past.');
    check('names: sentences without names pass through',
        S.replaceNamesInSentence('She kneels beside him.', sheet) === 'She kneels beside him.');
    check('names: empty tolerated', S.replaceNamesInSentence('', sheet) === '');
}

// ---------------------------------------------------------------- dress-derived negative
{
    check('neg: traditional-only dress fires the anti-modern negative',
        /modern military uniform/.test(S.antiModernNegative('shihakushō, black kosode, hakama')));
    check('neg: declared-modern worlds are untouched',
        S.antiModernNegative('suit, necktie, dress shirt') === '' && S.antiModernNegative('black kosode, necktie') === '');
    check('neg: empty dress is neutral', S.antiModernNegative('') === '');
}

// ---------------------------------------------------------------- subject-derived seeds
{
    check('seed: same who-set, same seed — recurring characters stay consistent',
        S.seedForPanel(12345, ['Jovan Oda', 'Rukia Kuchiki']) === S.seedForPanel(12345, ['rukia kuchiki', 'JOVAN ODA']));
    check('seed: different who-set decorrelates — palette priors cannot bleed across subjects',
        S.seedForPanel(12345, ['Jovan Oda']) !== S.seedForPanel(12345, ['Rukia Kuchiki']));
    check('seed: stays in NAI range', (() => { const v = S.seedForPanel(2147483000, ['A','B']); return Number.isInteger(v) && v >= 0 && v < 2147483647; })());
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
        duo.counts === '1girl, 1boy'
        && duo.blocks[0] === 'woman, short silver hair, grey eyes, tall, captain haori, kneeling beside him, glowing green hands on his chest, fierce expression'
        && duo.blocks[1] === 'man, long black spiked hair, bells in hair, eyepatch, towering muscular build, kneeling in crater, shredded forearms, laughing'
        && duo.missing.length === 0);
    check('identity: legacy string who entries still work',
        S.assembleIdentity(['Jovan Oda'], sheet).blocks[0].startsWith('man, medium white hair'));

    const trio = S.assembleIdentity([
        { name: 'Jovan Oda', state: 'standing' }, { name: 'Rukia Kuchiki', state: '' }, { name: 'Isane Kotetsu', state: 'running' },
    ], sheet);
    check('identity: the two-cap is uniform — assembleIdentity never welds a third subject',
        trio.blocks.length === 2 && !/foreground left|foreground right/.test(trio.blocks.join(' ')));

    const bad = S.assembleIdentity([{ name: 'Elderly Stranger', state: 'watching' }, 'Jovan Oda'], sheet);
    check('identity: unknown names reported, never invented',
        bad.missing.length === 1 && bad.missing[0] === 'Elderly Stranger' && bad.blocks.length === 1);
    check('identity: empty who tolerated', S.assembleIdentity([], sheet).counts === '');

    // Field regression, snap_31: a courtyard of 300 rendered as gray mass and a
    // principal vanished, because the counts claimed a two-person world.
    check('counts: run in BLOCK order — a fixed order mislabels the first figure',
        S.assembleIdentity([{ name: 'Rukia Kuchiki', state: 'shouting' }, { name: 'Jovan Oda', state: 'standing' }], sheet, {}).counts === '1girl, 1boy'
        && S.assembleIdentity([{ name: 'Jovan Oda', state: 'standing' }, { name: 'Rukia Kuchiki', state: 'shouting' }], sheet, {}).counts === '1boy, 1girl');
    // Reverted in 0.21.0: the `crowd` tag asked for indistinct background mass and got
    // it. The population lives in the setting's own words, never in the count run.
    check('counts: no crowd tag reaches the count run at all',
        (() => { const id = S.assembleIdentity([{ name: 'Jovan Oda', state: 'standing' }, { name: 'Rukia Kuchiki', state: 'shouting' }], sheet, { crowd: true });
            return id.counts === '1boy, 1girl' && !('crowdTag' in id); })());
    check('crowd: detected from the words the image model reads, not guessed',
        S.framesCrowd('dispersing crowd of shinigami in black shihakusho') && S.framesCrowd('tile roofs with standing officers')
        && S.framesCrowd('packed courtyard') && S.framesCrowd('ranks of soldiers')
        && !S.framesCrowd('empty stone courtyard, memorial stone, bare plum tree'));

    // Field regression, snap_31 panel 2: a figure the builder itself put across the
    // courtyard got a full principal block and half the frame's attention.
    {
        const split = S.splitPrincipals([
            { name: 'Ashida Tetsuzan', state: 'right hand raised in salute to brow' },
            { name: 'Jovan Oda', state: 'arm raised overhead, seen from behind at distance' },
        ]);
        check('who: a distant figure is demoted out of principals',
            split.principals.length === 1 && split.principals[0].name === 'Ashida Tetsuzan' && split.background.length === 1);
        check('who: background phrasings are all caught',
            S.splitPrincipals([{ name: 'A', state: 'far away in the background' }, { name: 'B', state: 'tiny in the frame' }, { name: 'C', state: 'standing' }]).principals.length === 1);
        check('who: a frame is never left with zero subjects',
            S.splitPrincipals([{ name: 'A', state: 'in the distance' }]).principals.length === 1);
    }

    // Field regression, snap_31 panel 2: the builder restated appearance without
    // commas, so the whole block rode into the prompt a second time.
    check('scrub: a space-joined restatement of appearance is still a duplicate',
        S.scrubState('tall lean sharp-featured, arm raised overhead holding sky-blue katana', 'man, white hair, tall, lean, sharp-featured, black kosode')
            === 'arm raised overhead holding sky-blue katana');
    // Field regression, snap_31 v0.14.0: the builder wrote count tags into `state`, so
    // "2boys, <Jovan block>, 1boy, ..., <old man block>, 1boy" reached the model and the
    // two men fused into one old white-haired man holding the sword.
    check('scrub: count tags never survive inside a character block',
        S.scrubState('1boy, sky-blue blade raised overhead, both hands gripping hilt', 'man, white hair, tall')
            === 'sky-blue blade raised overhead, both hands gripping hilt'
        && S.scrubState('1girl, solo, crowd, tears at corners of eyes', 'woman, petite') === 'tears at corners of eyes'
        && S.scrubState('2boys, multiple girls, standing', 'man, tall') === 'standing');

    // Field regression: "low angle, full body, wide shot" — the model split the
    // difference and the figures came out unreadable.
    check('shot grammar: exactly one framing tag and one angle tag survive, first of each',
        S.enforceShotGrammar('1boy, standing, low angle, full body, wide shot, dust motes')
            === '1boy, standing, low angle, full body, dust motes'
        && S.enforceShotGrammar('close-up, from below, dutch angle, extreme close-up, rain')
            === 'close-up, from below, rain');
    check('shot grammar: a compliant panel is left alone',
        S.enforceShotGrammar('1girl, crying, cowboy shot, from side, backlighting')
            === '1girl, crying, cowboy shot, from side, backlighting');

    // Field regression: Rukia's cast entry carries no garment, so the model dressed her
    // from its own priors — a shinigami lieutenant in a school blazer.
    check('dress: an undressed principal is dressed by code from the world dress',
        S.assembleIdentity([{ name: 'Rukia Kuchiki', state: 'shouting' }],
            'Rukia Kuchiki: woman, petite, short black hair, violet eyes',
            { dress: 'black shihakusho' }).blocks[0].includes('black shihakusho'));
    check('dress: a principal the sheet already dresses is not re-dressed',
        S.assembleIdentity([{ name: 'Jovan Oda', state: 'standing' }],
            'Jovan Oda: man, white hair, black kosode',
            { dress: 'black shihakusho' }).blocks[0].includes('black shihakusho') === false);
    check('dress: garment detection and world-dress pick',
        S.hasGarment('man, white hair, black kosode') && !S.hasGarment('woman, petite, violet eyes')
        && S.firstGarmentTag('black kosode, no insignia, black shihakusho') === 'black kosode'
        && S.firstGarmentTag('pale winter sun, stone courtyard') === '');

    // Field regression, snap_31 v0.15.0: 0.15.0 forbade garments in `state` in prose and
    // shipped no enforcer. "shinigami uniform" reached the model over the welded
    // shihakusho and rendered a modern military uniform.
    check('scrub: a garment named in state is dropped — clothing has one source',
        S.scrubState('shinigami uniform, salute held, wet-eyed', 'old man, clouded eye, spotted hands')
            === 'salute held, wet-eyed');
    check('scrub: clothing CONDITION is state, not wardrobe, and survives',
        S.scrubState('torn black kosode, bleeding', 'man, white hair').includes('torn black kosode')
        && S.scrubState('coat tails stirring in wind, running', 'man, tall').includes('coat tails stirring in wind'));

    // Field regression: "dispersing crowd" was stamped unchanged onto all four panels of
    // a scene whose courtyard is erupting.
    check('setting: a transient activity is stripped, the population and its dress kept',
        S.stripTransientFromSetting('courtyard, dispersing crowd of shinigami in black shihakusho, bare plum tree')
            === 'courtyard, crowd of shinigami in black shihakusho, bare plum tree'
        && S.stripTransientFromSetting('cheering crowd, marching soldiers') === 'crowd, soldiers');
    // Field regression, snap_31 v0.16.0: the panel ended on "as the ," — a dangling
    // fragment the image model has to interpret.
    check('sentence: a long sentence is cut at a boundary, never mid-word',
        (() => {
            const s = 'The courtyard erupts and three hundred voices slam into the chant at once, fists punch the cold air, a cook waves his ladle overhead, nurses cry and chant together, and officers on the roof tiles leap to their feet as the sound rolls out over the wall.';
            const c = S.capSentenceSafe(s, 220);
            return c.length <= 221 && !/[\s,;:]$/.test(c) && s.startsWith(c.replace(/\.$/, ''));
        })());
    check('sentence: a short sentence is untouched',
        S.capSentenceSafe('She kneels beside him.', 220) === 'She kneels beside him.');
    check('sentence: cuts at a full stop when one is available late enough',
        S.capSentenceSafe('A'.repeat(120) + '. ' + 'B'.repeat(200), 220).endsWith('.')
        && S.capSentenceSafe('A'.repeat(120) + '. ' + 'B'.repeat(200), 220).length === 121);

    // Field regression: the macron made "shihakusho" a token the model never trained on,
    // and the garment came back as a modern black dress shirt.
    check('tags: Latin diacritics are folded to the trained danbooru spelling',
        S.foldTagDiacritics('black shihakush\u014d, caf\u00e9 table') === 'black shihakusho, cafe table');
    check('tags: non-Latin scripts are left alone',
        S.foldTagDiacritics('1girl, \u6b7b\u795e, black shihakusho') === '1girl, \u6b7b\u795e, black shihakusho');

    // The plan pass: the strip is laid out and checked as a LIST before any tag exists.
    {
        const goodPlan = S.parsePlan(JSON.stringify({ setting: 'courtyard, crowd of shinigami in black shihakusho', dress: 'black shihakusho', plan: [
            { beat: 'He raises the blade over the courtyard.', between: 'she is at his shoulder, chanting up at the blade he raised', who: ['Jovan Oda', 'Rukia Kuchiki'] },
            { beat: 'The old soldier salutes the memorial stone.', follows: 'the blade is up now, and the veteran answers it', who: ['Ashida Tetsuzan'] },
            { beat: 'The whole courtyard erupts into the chant.', follows: 'the salute breaks the silence and three hundred voices follow', who: [] },
        ] }), 4);
        check('plan: parsed into beats and who, world carried',
            goodPlan.panels.length === 3 && goodPlan.panels[2].who.length === 0 && goodPlan.dress === 'black shihakusho');
        // 0.43.0 inverts the crowd law: a bare who:[] frame is the problem now;
        // the crowd beat needs a foreground witness when named characters exist.
        check('plan: a bare crowd frame is flagged when named characters exist (0.43.0)',
            S.validatePlan(goodPlan, ['Jovan Oda', 'Rukia Kuchiki', 'Ashida Tetsuzan'], 4, { crowd: true })
                .some(p => p.includes('bare crowd frame')));
        check('plan: a bare crowd frame is legal with an empty cast',
            S.validatePlan(goodPlan, [], 4, { crowd: true }).length === 0);
        check('plan: a crowd beat with a foreground witness raises no crowd problem',
            !S.validatePlan({ panels: [
                { beat: 'He raises the blade over the courtyard.', who: ['Jovan Oda'] },
                { beat: 'The old soldier salutes as the courtyard erupts behind him.', follows: 'the blade is up now', who: ['Ashida Tetsuzan'] },
            ] }, ['Jovan Oda', 'Ashida Tetsuzan'], 4, { crowd: true })
                .some(p => p.includes('bare crowd frame')));
        check('plan: the chain is carried, panel 1 needs no antecedent',
            goodPlan.panels[0].follows === '' && goodPlan.panels[1].follows.includes('blade is up'));
    }
    // Field regression, v0.16.0: the same beat spent twice, and an all-solo strip.
    check('plan: one beat rendered twice is caught',
        S.beatsAreTheSame('The sky-blue blade leaps free of its sheath into the air.', 'The sky-blue blade leaps into the air above him.')
        && !S.beatsAreTheSame('He raises the blade over the courtyard.', 'The old soldier salutes the memorial stone.'));
    check('plan: an all-solo strip is caught',
        S.validatePlan({ panels: [
            { beat: 'He raises the blade.', who: ['Jovan Oda'] },
            { beat: 'She shouts with the division.', follows: 'his shout lands', who: ['Rukia Kuchiki'] },
            { beat: 'The old soldier salutes.', follows: 'her voice carries to the ranks', who: ['Ashida Tetsuzan'] },
        ] }, ['Jovan Oda', 'Rukia Kuchiki', 'Ashida Tetsuzan'], 4, {})
            .some(p => p.includes('Every panel is a single person')));
    // Field regression, snap_31 v0.19.1: panels 1 and 2 were one sword-draw split in
    // two, which spent the panel Rukia needed.
    check('plan: the same lone character twice in a row is caught',
        S.validatePlan({ panels: [
            { beat: 'The blade leaps from its sheath.', who: ['Jovan Oda'] },
            { beat: 'He catches it and raises it overhead.', follows: 'the blade is free and falls into his hand', who: ['Jovan Oda'] },
        ] }, ['Jovan Oda'], 4, {})
            .some(p => p.includes('are both Jovan Oda alone')));
    check('plan: the same character in consecutive panels WITH someone else is allowed',
        !S.validatePlan({ panels: [
            { beat: 'He raises the blade.', who: ['Jovan Oda'] },
            { beat: 'She answers at his shoulder.', follows: 'the blade is up', between: 'she chants up at the blade he raised', who: ['Jovan Oda', 'Rukia Kuchiki'] },
        ] }, ['Jovan Oda', 'Rukia Kuchiki'], 4, {})
            .some(p => p.includes('alone')));
    // Field regression: Rukia and Renji shared a frame doing unrelated things.
    check('plan: a two-person frame with nothing passing between them is caught',
        S.validatePlan({ panels: [
            { beat: 'She chants while he laughs to himself.', who: ['Rukia Kuchiki', 'Renji Abarai'] },
        ] }, ['Rukia Kuchiki', 'Renji Abarai'], 4, {})
            .some(p => p.includes('without saying what passes between them')));
    check('plan: "between" is carried through the parse',
        S.parsePlan(JSON.stringify({ plan: [{ beat: 'They clash.', between: 'his blade meets her block', who: ['A', 'B'] }] }), 4)
            .panels[0].between === 'his blade meets her block');

    // Field regression, snap_31 v0.18.0: five panels in no order — the crowd already
    // roaring in panel 1, the sword raise that caused it in panel 4.
    check('plan: a panel that does not follow the one before it is caught',
        S.validatePlan({ panels: [
            { beat: 'He raises the blade.', who: ['Jovan Oda'] },
            { beat: 'The old soldier salutes.', who: ['Ashida Tetsuzan'] },
        ] }, ['Jovan Oda', 'Ashida Tetsuzan'], 4, {})
            .some(p => p.includes('does not say how it follows')));
    check('plan: a follows that merely restates its own beat is caught',
        S.validatePlan({ panels: [
            { beat: 'He raises the blade.', who: ['Jovan Oda'] },
            { beat: 'The old soldier salutes the memorial stone.', follows: 'the old soldier salutes the memorial stone', who: ['Ashida Tetsuzan'] },
        ] }, ['Jovan Oda', 'Ashida Tetsuzan'], 4, {})
            .some(p => p.includes('just restates its own beat')));
    check('plan: an unknown name and a missing who field are caught',
        (() => { const p = S.validatePlan({ panels: [{ beat: 'A stranger waves.', who: ['Nobody Here'] }, { beat: 'Wind moves.', follows: 'the square empties', who: null }] }, ['Jovan Oda'], 4, {});
            return p.some(x => x.includes('not in the cast sheet')) && p.some(x => x.includes('no "who" field')); })());
    check('plan: a crowd scene where no beat shows the crowd is caught (0.43.0)',
        S.validatePlan({ panels: [
            { beat: 'He raises the blade.', who: ['Jovan Oda'] },
            { beat: 'She meets his eyes.', follows: 'the blade is up and she answers it', between: 'she answers the blade he raised', who: ['Jovan Oda', 'Rukia Kuchiki'] },
            { beat: 'The old soldier salutes.', follows: 'her voice carries into the ranks', who: ['Ashida Tetsuzan'] },
        ] }, ['Jovan Oda', 'Rukia Kuchiki', 'Ashida Tetsuzan'], 4, { crowd: true })
            .some(p => p.includes('no panel shows it')));
    check('plan: unparseable output returns null so the caller can fall back',
        S.parsePlan('sorry, I cannot do that', 4) === null && S.parsePlan('{"panels":[]}', 4) === null);

    // Field regression, snap_31 v0.17.0: a lieutenant in a black military tunic with
    // collar tabs and an eagle, because her own cast line said "lieutenant's badge".
    check('rank: a rank decoration is stripped from the cast block itself',
        S.stripRankInsignia("woman, petite, violet eyes, lieutenant's badge") === 'woman, petite, violet eyes');
    // Field regression, snap_31 v0.18.0: 0.17.0 put a character name tag AND a body
    // description in one block; the model's own idea of the character fought the body
    // and returned a Renji with a woman's chest.
    check('name: a character name tag and its work tag are stripped from the welded block',
        (() => { const b = S.assembleIdentity([{ name: 'Renji Abarai', state: 'arms crossed' }],
            'Renji Abarai: man, abarai renji, bleach, long red hair, brown eyes, muscular', {}).blocks[0];
            return !b.includes('abarai renji') && !b.includes('bleach') && b.includes('long red hair') && b.includes('muscular'); })());
    check('name: a sheet with no name tag is untouched',
        S.stripNameTags('man, tall, muscular, white headband', 'Renji Abarai') === 'man, tall, muscular, white headband');
    check('name: a body word that happens to match nothing survives',
        S.stripNameTags('woman, petite, short black hair, violet eyes', 'Rukia Kuchiki') === 'woman, petite, short black hair, violet eyes');

    check('rank: the WELDED block never carries a rank decoration',
        (() => { const b = S.assembleIdentity([{ name: 'Rukia Kuchiki', state: 'shouting' }],
            "Rukia Kuchiki: woman, petite, short black hair, violet eyes, lieutenant's badge",
            { dress: 'black shihakusho' }).blocks[0];
            return !b.includes('badge') && b.includes('black shihakusho'); })());
    check('rank: a decoration smuggled in through state is stripped too',
        !S.assembleIdentity([{ name: 'A', state: "captain's insignia, standing" }], 'A: man, tall', {}).blocks[0].includes('insignia'));
    check('rank: a garment that merely belongs to a rank survives',
        S.stripRankInsignia("man, white hair, captain's haori") === "man, white hair, captain's haori");

    check('setting: standing description untouched',
        S.stripTransientFromSetting('stone courtyard, memorial stone, pale winter sun')
            === 'stone courtyard, memorial stone, pale winter sun');

    // Field regression, snap_31 v0.20.0: "petite" in the block plus "small posture" in
    // the state rendered a chibi-proportioned adult beside a normal-sized man.
    check('scrub: a state that merely repeats the cast sheet stature is dropped',
        S.scrubState('small posture, violet eyes fixed upward', 'woman, petite, violet eyes')
            === 'violet eyes fixed upward'
        && S.scrubState('tiny frame, shouting', 'woman, petite') === 'shouting');
    check('scrub: stature survives when the cast sheet does not already state it',
        S.scrubState('small frame, shouting', 'woman, black hair').includes('small frame'));
    check('scrub: a size word inside a real action tag is not a stature restatement',
        S.scrubState('small smile playing at her mouth, standing', 'woman, petite').includes('small smile'));

    check('scrub: one-word reuse survives; 2+ word hair-identity phrases are the bleed vector and drop',
        S.scrubState('wind blowing, teeth clenched', 'man, white hair, tall').includes('wind blowing')
        && S.scrubState('white hair blowing in wind, teeth clenched', 'man, white hair, tall') === 'teeth clenched');
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


// ---------------------------------------------------------------- name scrub — escape-class regression (v0.12.x $item bug)
{
    const sheet = 'Rangiku Matsumoto: woman, long orange hair, blue eyes\nToshiro Hitsugaya: boy, white hair, teal eyes';
    check('names: names containing "t" are scrubbed (the $item/tab escape-class regression)',
        S.replaceNamesInSentence('Matsumoto shields Hitsugaya from the blast.', sheet)
            === 'the woman shields the boy from the blast.');
    check('names: a bracketed name never throws (unescaped [ was a generation-killer)',
        (() => { try { return S.replaceNamesInSentence('Ray strikes.', 'Ra[y: man, tall') === 'Ray strikes.'; } catch { return false; } })());
    check('names: regex metacharacters in a cast name never throw and still scrub',
        S.replaceNamesInSentence('Vex strikes first.', 'Vex (Prime): man, goggles') === 'the man strikes first.');
    check('names: multi-word gender lead yields the right role word',
        S.replaceNamesInSentence('Bruno waves at the crowd.', 'Bruno: young man, scar') === 'the man waves at the crowd.');
}

// ---------------------------------------------------------------- gender words by boundary, not exact match
{
    const r = S.assembleIdentity(['A', 'B'], 'A: young man, facial scar\nB: old woman, wooden cane');
    check('identity: multi-word gender leads still count (young man / old woman)', r.counts === '1boy, 1girl');
    check('identity: "woman" never miscounts as man (boundary, not substring)',
        S.assembleIdentity(['C'], 'C: woman, tall').counts === '1girl');
}

// ---------------------------------------------------------------- count canon keeps 'multiple' readable
{
    check('counts: "multiple boys" keeps its space — never the broken multipleboys tag',
        S.normalizeCountTags('multiple boys, crowd, courtyard') === 'multiple boys, crowd, courtyard');
    check('counts: "multiple men" canonicalizes to "multiple boys"',
        S.normalizeCountTags('multiple men, crowd') === 'multiple boys, crowd');
}

// ---------------------------------------------------------------- tag-safe caps + panel object guard
{
    check('cap: overlong lists cut at a tag boundary, never mid-word',
        (() => { const s = Array.from({ length: 80 }, (_, i) => `statetag${i}`).join(', '); const c = S.capTagSafe(s, 500); return c.length <= 500 && c.split(', ').every(x => /^statetag\d+$/.test(x)); })());
    check('cap: short strings untouched', S.capTagSafe('a, b', 500) === 'a, b');
    const long = Array.from({ length: 80 }, (_, i) => `statetag${i}`).join(', ');
    const capped = S.parsePanels(JSON.stringify({ panels: [{ who: [{ name: 'A', state: long }], prompt: 'wide shot, dust cloud' }] }), 'tags', 4, {});
    check('parse: who-state is capped tag-safe — no trailing fragment can reach the weld',
        capped[0].who[0].state.split(', ').every(x => /^statetag\d+$/.test(x)));
    // A crowd/establishing frame is legal: "who": [] declared explicitly is the scene's
    // widest shot, not builder non-compliance. Omitting the field entirely still is.
    const declared = S.parsePanels(JSON.stringify({ panels: [
        { who: [], prompt: 'wide shot, roaring courtyard' },
        { prompt: '1boy, close-up' },
    ] }), 'tags', 4, {});
    check('parse: an empty who is distinguished from an omitted one',
        declared.length === 2 && declared[0].whoDeclared === true && declared[1].whoDeclared === false);

    const objless = S.parsePanels(JSON.stringify({ panels: [{ who: [{ name: 'A', state: 'x' }] }, { prompt: '1boy, smile' }] }), 'tags', 4, {});
    check('parse: a panel object without a prompt is dropped — never "[object Object]"',
        objless.length === 1 && objless[0].prompt.includes('1boy') && !JSON.stringify(objless).includes('object Object'));
}

// ---------------------------------------------------------------- structured single frame (identity is code in EVERY mode)
{
    const raw = JSON.stringify({ setting: 'courtyard, snow, packed stands', dress: 'black kosode', panels: [{ who: [{ name: 'A', state: 'kneeling, trembling hands' }], prompt: 'wide shot, from below, dramatic lighting', sentence: 'He kneels alone at the center of the snowy courtyard.' }] });
    const out = S.parsePanels(raw, 'tags', 1, { expectJson: true });
    check('parse: expectJson opens the JSON path for a single frame (bubbles off)',
        out.length === 1 && out[0].who?.[0]?.name === 'A' && out[0].sentence.startsWith('He kneels') && out.setting === 'courtyard, snow, packed stands' && out.dress === 'black kosode');
    const legacy = S.parsePanels('1boy, white hair, courtyard, snow', 'tags', 1, {});
    check('parse: single frame without expectJson keeps the legacy plain-line path',
        legacy.length === 1 && legacy[0].prompt === '1boy, white hair, courtyard, snow' && !legacy[0].who);
}

// ---------------------------------------------------------------- background figure keeps its verb (0.22.0)
{
    const sheet = 'Jovan: man, white hair, pale-blue eyes, tall, lean, black kosode\nTetsuzan: man, old man, clouded eye, spotted hands, black shihakusho';
    // Field bug: the saluting old man rendered HOLDING the distant figure's sword,
    // because the demotion threw the demoted figure's state away.
    const tag = S.backgroundFigureTag([{ name: 'Jovan', state: 'holding sword overhead, sky-blue blade, distant figure in the background' }], sheet);
    check('bg: demoted figure carries its action', /holding sword overhead/.test(tag) && /sky-blue blade/.test(tag));
    check('bg: constant prefix/suffix kept', tag.startsWith('distant figure ') && tag.endsWith(' in the background'));
    // Appearance and garments are scrubbed by the owner's own cast block: no second identity.
    const app = S.backgroundFigureTag([{ name: 'Jovan', state: 'white hair, black kosode, arm raised high' }], sheet);
    check('bg: appearance + garment scrubbed, action survives', !/white hair|black kosode/.test(app) && /arm raised high/.test(app));
    check('bg: no state -> the old constant', S.backgroundFigureTag([{ name: 'Jovan', state: '' }], sheet) === 'distant figure in the background');
    check('bg: unknown name tolerated (state scrubbed against empty block)',
        /raising both fists/.test(S.backgroundFigureTag([{ name: 'Nobody', state: 'raising both fists' }], sheet)));
    const two = S.backgroundFigureTag([
        { name: 'Jovan', state: 'holding sword overhead' },
        { name: 'Tetsuzan', state: 'standing at attention' },
    ], sheet);
    check('bg: two demoted figures both contribute, tag-safely capped',
        /holding sword overhead/.test(two) && two.length < 60 + 'distant figure  in the background'.length);
}

// ---------------------------------------------------------------- anchor owns the environment (0.22.0)
{
    const anchor = 'Thirteenth Division barracks courtyard, winter morning pale sun, wind in bare branches, plum tree bare, stone fountain, wooden barracks verandas, tiled barracks rooftops, crowd of shinigami in black shihakusho, officers standing on roof tiles, scattered plum blossoms on ground, black kosode';
    // The field prompt: the whole courtyard block restated inside the panel prompt.
    const restated = 'wide shot, dutch angle, dramatic lighting, stone fountain, tiled barracks rooftops, scattered plum blossoms on ground, officers standing on roof tiles, fists punching the cold air, speed lines';
    const out = S.dedupeAgainstAnchor(restated, anchor);
    check('dedupe: restated environment tokens removed',
        !/stone fountain|tiled barracks rooftops|scattered plum blossoms|officers standing on roof tiles/.test(out));
    check('dedupe: camera, lighting, and ACTION survive',
        /wide shot/.test(out) && /dutch angle/.test(out) && /dramatic lighting/.test(out) && /fists punching the cold air/.test(out) && /speed lines/.test(out));
    // Word-set overlap in any order counts as restatement.
    check('dedupe: reordered restatement still caught',
        S.dedupeAgainstAnchor('full body, branches in wind bare, shouting', anchor) === 'full body, shouting');
    // An action phrase that merely SHARES words with the anchor is not a restatement.
    const action = S.dedupeAgainstAnchor('crowd of shinigami in black shihakusho roaring', anchor);
    check('dedupe: action phrase with extra words survives', action === 'crowd of shinigami in black shihakusho roaring');
    // Single-word tokens are never anchor-claimed (too aggressive otherwise).
    check('dedupe: single-word tokens survive', S.dedupeAgainstAnchor('wind, shouting', anchor) === 'wind, shouting');
    // Self-duplicates inside one prompt collapse.
    check('dedupe: self-duplicates collapse',
        S.dedupeAgainstAnchor('wide shot, lens flare, lens flare, wind', '') === 'wide shot, lens flare, wind');
    check('dedupe: empty anchor tolerated', S.dedupeAgainstAnchor('1boy, shouting', '') === '1boy, shouting');
    check('dedupe: empty prompt tolerated', S.dedupeAgainstAnchor('', anchor) === '');
}

// ---------------------------------------------------------------- role-uniform neutralization (0.23.0)
{
    const tradDress = 'black shihakusho, black kosode';
    const modernDress = 'blazer, necktie, school uniform';
    // Field bug: 'shinigami uniform' in the cast block rendered a black gakuran with
    // gold buttons over a black-shihakusho world.
    check('uniform: role-uniform stripped in a traditional world',
        S.neutralizeRoleUniforms('man, gray hair, shinigami uniform, spotted hands', tradDress) === 'man, gray hair, spotted hands');
    check('uniform: untouched in a modern world',
        S.neutralizeRoleUniforms('man, gray hair, shinigami uniform', modernDress) === 'man, gray hair, shinigami uniform');
    check('uniform: plain garments survive', /black kosode/.test(S.neutralizeRoleUniforms('man, black kosode', tradDress)));
    check('uniform: empty tolerated', S.neutralizeRoleUniforms('', tradDress) === '');
    // End-to-end at the weld: the neutralized block picks up the world's garment.
    const sheet = 'Rukia Kuchiki: woman, short black hair, violet eyes, petite, shinigami uniform, lieutenant armband';
    const id = S.assembleIdentity([{ name: 'Rukia Kuchiki', state: 'hands folded at front, tears forming' }], sheet,
        { dress: 'black shihakusho', worldDress: tradDress });
    check('weld: uniform and rank armband gone, world garment welded, face intact',
        !/uniform|armband/.test(id.blocks[0]) && /black shihakusho/.test(id.blocks[0])
        && /short black hair/.test(id.blocks[0]) && /violet eyes/.test(id.blocks[0]));
    // A plain visible armband is a garment, not a rank decoration — it stays.
    check('insignia: rank+armband dropped, plain armband kept',
        S.stripRankInsignia('white armband on left arm') === 'white armband on left arm'
        && !/armband/.test(S.stripRankInsignia('lieutenant armband')));
    // The demoted figure's action no longer doubles the locative.
    const bg = S.backgroundFigureTag([{ name: 'J', state: 'arm raised high, seen from behind and below in the background' }], 'J: man, tall');
    check('bg: locatives owned by the wrapper, never doubled',
        (bg.match(/in the background/g) || []).length === 1 && !/seen from/.test(bg) && /arm raised high/.test(bg));
}

// ---------------------------------------------------------------- seen-from-behind demotion + one sky per strip (0.25.0)
{
    // Field bug: a second principal whose state was "seen from behind" stayed a
    // principal; the model resolved the two-person frame with his blade across HER neck.
    const sp = S.splitPrincipals([
        { name: 'Rukia', state: 'hands folded at front, tears forming' },
        { name: 'Jovan', state: 'sword raised overhead, seen from behind' },
    ]);
    check('demote: seen-from-behind is scenery, not a principal',
        sp.principals.length === 1 && sp.principals[0].name === 'Rukia' && sp.background.length === 1 && sp.background[0].name === 'Jovan');
    // The demoted figure still carries its verb.
    const bgt = S.backgroundFigureTag(sp.background, 'Jovan: man, white hair, black kosode');
    check('demote: the blade follows the demoted figure', /sword raised overhead/.test(bgt));
    // A genuine two-shot is NOT demoted.
    const duo = S.splitPrincipals([
        { name: 'A', state: 'facing her, hand extended' },
        { name: 'B', state: 'meeting his eyes, blushing' },
    ]);
    check('demote: facing each other stays a two-shot', duo.principals.length === 2 && duo.background.length === 0);

    const anchor = 'barracks courtyard, pale sun, winter light, wind in bare branches';
    // Field bug: one courtyard rendered as full-moon night / warm noon / purple dusk
    // across three panels of one continuous minute.
    const lit = S.unifyStripLighting('dramatic backlighting, lens flare, sunset, dust motes', anchor);
    check('sky: panel light tokens dropped under an anchor sky, atmosphere kept',
        !/backlighting|sunset/.test(lit) && /lens flare/.test(lit) && /dust motes/.test(lit));
    check('sky: no anchor light -> panel light untouched',
        S.unifyStripLighting('moonlight, crickets', 'barracks courtyard, stone fountain') === 'moonlight, crickets');
    check('sky: empty tolerated', S.unifyStripLighting('', anchor) === '');
    check('sky: non-light tokens never match (sundress is not the sun)',
        S.unifyStripLighting('white sundress, smiling', anchor) === 'white sundress, smiling');
}

// ---------------------------------------------------------------- NSFW weld + crowd hoist (0.26.0)
{
    // The weld dressed everybody; a state of undress must undress the weld.
    check('undress: nude strips every welded garment, keeps body traits',
        S.applyUndress('woman, long red hair, violet eyes, black dress, gloves', 'completely nude, nipples, breasts')
            === 'woman, long red hair, violet eyes');
    check('undress: condition token strips only the named garment',
        S.applyUndress('man, white hair, black kosode, black hakama', 'kosode removed, chest bare')
            === 'man, white hair, black hakama');
    check('undress: plain state untouched',
        S.applyUndress('man, black kosode', 'standing tall, shouting') === 'man, black kosode');
    check('undress: empty tolerated', S.applyUndress('', 'nude') === '');
    // Anatomy tags pass through the state scrub untouched.
    check('undress: explicit anatomy survives scrubState',
        /nipples/.test(S.scrubState('nipples, breasts, pussy, blush', 'woman, long hair, black dress')));
    // Explicit frames never demote — a from-behind partner is the position.
    const ex = S.splitPrincipals([
        { name: 'A', state: 'nude, breasts, on all fours' },
        { name: 'B', state: 'nude, penis, seen from behind, doggystyle' },
    ]);
    check('undress: explicit frame keeps both principals (the 0.25.0 NSFW regression)',
        ex.principals.length === 2 && ex.background.length === 0);
    // And the weld end-to-end: no garment survives a nude state.
    const nid = S.assembleIdentity([{ name: 'Mira', state: 'completely nude, nipples, breasts, kneeling' }],
        'Mira: girl, long silver hair, blue eyes, school uniform', { dress: 'blazer', worldDress: 'blazer' });
    check('undress: welded block carries anatomy and NO garments',
        !/uniform|blazer|dress/.test(nid.blocks[0]) && /nipples/.test(nid.blocks[0]));

    // Crowd hoist: anchor's crowd words move forward only when the frame has a crowd.
    const anch = 'barracks courtyard, pale sun, packed standing crowd of shinigami spectators, stone fountain';
    check('hoist: crowd words hoisted when the frame has a crowd',
        S.hoistCrowdTokens(anch, true) === 'packed standing crowd of shinigami spectators');
    check('hoist: silent when the frame has no crowd', S.hoistCrowdTokens(anch, false) === '');
    check('hoist: non-crowd anchor tokens never hoisted', !/courtyard|fountain/.test(S.hoistCrowdTokens(anch, true)));

    // Welded garment goes BEFORE the state, braced in a traditional world.
    const gid = S.assembleIdentity([{ name: 'Rukia', state: 'hands folded, tears forming' }],
        'Rukia: woman, short black hair, violet eyes, petite', { dress: 'black shihakusho', worldDress: 'black shihakusho' });
    const gb = gid.blocks[0];
    check('garment: welded dress precedes state, unbraced',
        gb.indexOf('black shihakusho') !== -1 && !gb.includes('{')
        && gb.indexOf('black shihakusho') < gb.indexOf('hands folded'));
    // appendAnchor sees through braces — no tail duplicate.
    check('garment: anchor dedupe sees through emphasis braces',
        S.appendAnchor('1girl, {black shihakusho}, wind', 'black shihakusho, courtyard') === '1girl, {black shihakusho}, wind, courtyard');
}

// ---------------------------------------------------------------- NSFW state budget + state lighting scrub (0.27.0)
{
    // The 200-char cap amputated anatomy off the end of explicit states.
    // Anatomy lands at ~206 chars here: cut at 200, kept at 420.
    const longState = 'completely nude, nipples, breasts, ' + Array(6).fill('trembling with pleasure').join(', ') + ', pussy, vaginal sex';
    check('nsfw: explicit states keep their anatomy past the old 200-char cap',
        /pussy, vaginal sex$/.test(S.scrubState(longState, 'woman, long hair', 420))
        && !/vaginal sex/.test(S.scrubState(longState, 'woman, long hair', 200)));
    check('nsfw: SFW states still cap at 200',
        S.scrubState(Array(30).fill('standing very still').join(', '), 'man, tall', 200).length <= 201);
    check('nsfw: cap defaults to 200 when omitted',
        S.scrubState(Array(30).fill('standing very still').join(', '), 'man, tall').length <= 201);
    // The explicit cap is chosen by EXPLICIT_STATE at the weld.
    const nid2 = S.assembleIdentity([{ name: 'Mira', state: longState }], 'Mira: girl, long silver hair, blue eyes', {});
    check('nsfw: the weld routes explicit states to the 420 budget',
        /vaginal sex/.test(nid2.blocks[0]));
    // Lighting in a STATE gets the same sky-unification as the shared prompt.
    check('sky: state-sourced lighting is scrubbed at the weld call site',
        src.includes('w.state = unifyStripLighting(String(w.state || \'\'), anchorText);'));
}

// ---------------------------------------------------------------- panel nudity + crowd actions + role purge (0.29.0)
{
    // Crowd tokens split from the rest so actions ride forward.
    const cx = S.extractCrowdTokens('wide shot, dispersing crowd laughing and retreating, dust motes, cheering shinigami with raised fists');
    check('crowd: action-bearing crowd tokens extracted, scenery kept',
        cx.crowd === 'dispersing crowd laughing and retreating'
        && cx.rest === 'wide shot, dust motes, cheering shinigami with raised fists');
    check('crowd: empty tolerated', S.extractCrowdTokens('').rest === '' && S.extractCrowdTokens('').crowd === '');
    // Role words purge in traditional worlds.
    check('roles: soldiers/officers purged, population words kept',
        S.purgeModernRoles('retreating soldiers, roof tiles with officers, crowd of shinigami in black shihakusho')
            === 'crowd of shinigami in black shihakusho');
    check('roles: empty tolerated', S.purgeModernRoles('') === '');
    // Panel-nude logic end to end: applyUndress with an appended 'nude' strips both blocks.
    const nid3 = S.assembleIdentity([
        { name: 'J', state: 'kneeling between her thighs, thrusting, nude' },
        { name: 'R', state: 'on back, arms above head, small breasts bouncing, nude' },
    ], 'J: man, white hair, black kosode\nR: woman, short black hair, violet eyes, shinigami uniform',
        { dress: 'black shihakusho', worldDress: 'black shihakusho' });
    check('nude: BOTH principals stripped of welded garments, anatomy kept',
        nid3.blocks.every(b => !/kosode|uniform/.test(b)) && /small breasts bouncing/.test(nid3.blocks[1]));
    // Euphemisms count as acts: 'drives deep' and 'stays buried inside her' escaped 0.29.0.
    check('nsfw: euphemistic acts are acts',
        S.panelLacksAnatomy({ prompt: 'cowboy shot, dramatic lighting', sentence: 'he stays buried inside her with his face against her breast', who: [{ name: 'A', state: 'above her' }] }) === true
        && S.panelLacksAnatomy({ prompt: 'missionary, vaginal sex, penis, pussy', sentence: '', who: [] }) === false
        && S.panelLacksAnatomy({ prompt: 'close-up, lying beside her propped on one elbow', sentence: 'they rest in the quiet', who: [{ name: 'A', state: 'small breasts exposed, nipples flushed' }] }) === false);
    // The anatomy enforcement and panel-nude weld are wired in source.
    check('src: sex act with zero genital tags costs one corrective retry',
        src.includes('panels.some(panelLacksAnatomy)') && src.includes('names no anatomy'));
    check('src: panel-level nudity is welded into every principal state',
        src.includes("st = [st.trim(), 'nude'].filter(Boolean).join(', ');") && src.includes('w.state = st;'));
    check('src: modern role words purged when the anti-modern gate fires',
        src.includes('const antiModernOn = !!antiModernNegative(rawDress);') && src.includes('purgeModernRoles(scrubEchoedCounts(p.prompt))'));
}

// ---------------------------------------------------------------- NAI guidance to the builder + panel focus law (0.30.0)
{
    check('guidance: the official NAI craft is handed to the builder, not buried in code',
        src.includes('const NAI_GUIDANCE = `') && src.includes('+ NAI_GUIDANCE')
        && src.includes('{sky-blue blade}') && src.includes('ORDER IS STRENGTH'));
    check('guidance: the panel focus law is the user\'s own (solo/duo/both-with-genitals)',
        src.includes('PANEL FOCUS LAW') && src.includes('A sex act is ALWAYS BOTH')
        && src.includes('EUPHEMISMS ARE FAILED PANELS'));
    check('guidance: complete nudity is demanded per naked character',
        src.includes("'completely nude'") && src.includes('ONLY when the scene text says the clothes stay on'));
}

// ---------------------------------------------------------------- explicit default-nude + personal garments (0.31.0)
{
    // A single-owner garment is that character's, never world dress.
    const cast = 'Jovan: man, white hair, black kosode\nRukia: woman, black hair, violet eyes\nTetsuzan: man, old, black shihakusho\nKiyone: girl, black shihakusho';
    check('dress: single-owner garments dropped, shared outfit kept',
        S.stripPersonalGarments('black kosode, black shihakusho', cast) === 'black shihakusho');
    check('dress: non-garment tokens pass through', S.stripPersonalGarments('winter morning', cast) === 'winter morning');
    check('dress: empty tolerated', S.stripPersonalGarments('', cast) === '');
    // Explicit default-nude end to end: 'breasts bouncing + buried deep' with no
    // literal 'nude' anywhere must STILL strip the welded garments (the 0.30.0 field).
    const explicitPanel = 'small breasts bouncing, flushed dark nipples wet, buried deep';
    const isExplicit = S.EXPLICIT_STATE.test(explicitPanel);
    check('nude: exposed anatomy marks the panel explicit without the word nude',
        isExplicit === true);
    // Clothes-stay-on guard: 'uniform pushed open' survives; 'nipples wet' is not a garment.
    const stayOn = st => String(st).split(',').some(tok => S.GARMENT_CONDITION.test(tok) && S.hasGarment(tok));
    check('nude: pushed-open keeps clothes ON, wet-nipples does not block nudity',
        stayOn('shinigami uniform pushed open, flushed') === true
        && stayOn('small breasts bouncing, flushed dark nipples wet') === false);
    // Euphemisms learned in 0.31.0.
    check('nsfw: buried deep / still joined are acts',
        S.SEX_ACT.test('hips pressed flush against hers, buried deep')
        && S.SEX_ACT.test('still joined')
        && !S.SEX_ACT.test('lying beside her propped on one elbow'));
    check('src: explicit panels weld nude by default, respecting clothes-stay-on',
        src.includes('const panelExplicit = p.explicit || /\\b(?:nude|naked)\\b/i.test('));
    check('src: the sex arc law is in the planner',
        src.includes('THE BEATS ARE IN THE SCENE, not in a template'));
    check('src: personal garments are stripped from the world dress',
        src.includes('const dress = cleanWorldDress(stripPersonalGarments(rawDress, getActiveCastSheet()), antiModernOn);'));
}

// ---------------------------------------------------------------- tracker-nude + dress hygiene + bubbles (0.32.0)
{
    // World dress hygiene: uniforms die in traditional worlds, decorations are never world dress.
    check('dress: uniforms and rank decorations never reach the anchor',
        S.cleanWorldDress('black kosode, school uniform, 3rd seat armband, black shihakusho', true) === 'black kosode, black shihakusho');
    check('dress: decorations dropped even in modern worlds',
        S.cleanWorldDress('school uniform, armband', false) === 'school uniform');
    // The wardrobe tracker outranks the builder.
    check('src: the scene tracker (| nothing |) strips garment-condition tokens and welds nude',
        src.includes("const sceneNude = /\\|\\s*(?:nothing|nude|naked)\\s*(?:\\||\\])/i.test(scene);")
        && src.includes('if (sceneNude) st = st.split'));
    // The planner must spend the budget on scene beats, not a template.
    check('src: beats are scene-driven, 2-of-4+ panels is a plan problem',
        src.includes('THE BEATS ARE IN THE SCENE, not in a template')
        && src.includes('maxPanels >= 4 && plan.panels.length <= 2'));
    // Em-dash walls no longer kill verbatim bubbles.
    const scene = '"—JOVAN—!" she screamed. "If you tell anyone, I\'ll have you transferred."';
    const b = S.sanitizeBubbles([{ speaker: 'Rukia', text: 'JOVAN—!' }, { speaker: 'Rukia', text: "If you tell anyone, I'll have you transferred" }], scene);
    check('bubbles: em-dashed cries verify verbatim', b.length === 2);
    // Two-voice beats are law now.
    check('src: bubbles law pushes two voices, moans are dialogue',
        src.includes('Use TWO lines whenever the beat has two voices')
        && src.includes('moans, cries, and spilled names ARE dialogue'));
}

// ---------------------------------------------------------------- code-counted beats + explicit anchor (0.33.0)
{
    const sexScene = `[Captain's Quarters | 20:07 | rain | nothing | above her on the futon]

He answered the name with his mouth and closed his lips over her breast, and the unfinished sentence died as a sound instead of words.

~t~*Can't think— say it again.*~/t~

"AH— hh— FUCK—" Her head cracked back into the pillow. He was pounding her now, no rhythm but deep, each thrust punching the breath out of her.

She felt it immediately — fuller, deeper, the stretch ratcheting past where it had been, every stroke driving into somewhere new.

Rain.

Her legs locked around his waist and her heels dug into the small of his back and she pulled him into every thrust, chasing it now, all protocol burned off.

He bit down on the curve of her breast and drove in deep and held there, and she broke apart with his name in her mouth at full volume.

Rukia lay under him with her chest heaving, flushed pink from her face to her breasts, the stubborn strand of hair glued to her cheek, tears drying.`;
    const beats = S.countSceneBeats(sexScene);
    check('beats: code counts prose beats — headers, thoughts, and one-liners excluded',
        beats === 6);
    check('beats: empty scene yields 0', S.countSceneBeats('') === 0);
    check('beats: two short paragraphs still count', S.countSceneBeats('He raised the blade high over the courtyard and shouted.\n\nThe crowd answered him.') === 2);
    // Explicit panels never get the world dress stamped.
    check('anchor: explicit panels drop the dress entirely',
        S.dressForPanel('black shihakusho, kosode', true) === ''
        && S.dressForPanel('black shihakusho, kosode', false) === 'black shihakusho, kosode');
    // Wiring.
    check('src: CODE BEAT COUNT is demanded of the builder and validated',
        src.includes('CODE BEAT COUNT') && src.includes('countSceneBeats(scene)')
        && src.includes('opts.beatCount'));
    check('src: the anchor drops dress on explicit panels',
        src.includes('dressForPanel(dress, p?.explicit)'));
    check('src: a dialogue-heavy scene with silent speech beats costs one retry',
        src.includes('speech beats shipped silent'));
}

// ---------------------------------------------------------------- phrase-overlap scrub + anatomy continuity (0.34.0)
{
    const hisBlock = 'man, tall, lean build, medium white hair, pale blue eyes, sharp features, no insignia';
    // The third repetition of his white hair in one frame bled onto her (field).
    check('scrub: hair-identity phrases repeated in state are dropped, gaze actions stay',
        !/medium white hair/.test(S.scrubState('medium white hair falling over her chest, jaw clenched', hisBlock))
        && /pale blue eyes intent/.test(S.scrubState('pale blue eyes intent, hips driven forward', hisBlock))
        && !/hair strand between eyes/.test(S.scrubState('hair strand between eyes stuck to cheek, sobbing', 'woman, short black hair, hair strand between eyes, violet eyes')));
    // Action and motion survive; condition garments survive.
    check('scrub: motion and condition garments survive the phrase rule',
        /small breasts bouncing/.test(S.scrubState('small breasts bouncing, back arched', 'woman, short black hair, violet eyes, petite'))
        && /black kosode pushed open/.test(S.scrubState('black kosode pushed open, sweat on back', hisBlock)));
    // The strip cannot amputate established anatomy in a later panel (field: the
    // finale's bare breast had no nipple).
    const anatomy = new Set(['nipples', 'pussy']);
    check('continuity: a bare-breast panel inherits nipples, open legs inherit pussy',
        /nipples$/.test(S.anatomyContinuity('chest heaving, flushed pink from face to breasts', anatomy))
        && /pussy$/.test(S.anatomyContinuity('legs fallen open, too spent to hold', anatomy)));
    check('continuity: never doubles, never invents',
        S.anatomyContinuity('nipples flushed dark', anatomy) === 'nipples flushed dark'
        && S.anatomyContinuity('chest heaving', new Set()) === 'chest heaving');
    // Bubbles: fewer than two in a dialogue-rich strip now costs a retry.
    check('src: bubble retry fires below 2 bubbles OR on silent speech beats',
        src.includes('bubbleTotal(panels) < 2 || silent.length')
        && src.includes('SPEECH_BEAT') && src.includes('speech beats with EMPTY bubbles'));
    // Echoed count tags die at assembly (field: '1boy 1girl' mid-prompt — the fusion vector).
    check('counts: echoed count tags scrubbed from shared prompts',
        S.scrubEchoedCounts('cowboy shot, 1boy 1girl, vaginal sex, sweat') === 'cowboy shot, vaginal sex, sweat');
    check('counts: non-count tokens survive', S.scrubEchoedCounts('1boy 1girl'.length ? 'crowd, wide shot' : '') === 'crowd, wide shot');
    // A lying subject never gets a from-below camera.
    check('src: lying subjects get from-below swapped to from-above',
        src.includes('LYING_STATE.test(String(w.state ||')
        && src.includes("p.prompt.replace(/\\bfrom below\\b/i, 'from above')"));
    check('lying: the detector knows lying, not standing',
        S.LYING_STATE.test('lying on back on futon, spent') && !S.LYING_STATE.test('standing tall, shouting'));
}

// ---------------------------------------------------------------- position inference (0.36.0)
{
    // 'under him' without a lying cue = cowgirl (field: she rendered on top).
    check('position: under-him infers lying on back',
        S.inferLyingFromPosition('heels locked behind his back, hips working in frantic circles under him')
            === 'heels locked behind his back, hips working in frantic circles under him, lying on back');
    check('position: existing lying cue untouched',
        S.inferLyingFromPosition('lying on back, hips working under him') === 'lying on back, hips working under him');
    check('position: no spatial claim untouched',
        S.inferLyingFromPosition('standing tall, shouting') === 'standing tall, shouting');
    check('src: the inference is welded before assembly',
        src.includes('w.state = inferLyingFromPosition(String(w.state || \'\'));'));
    check('src: explicit lying+above panels get an overhead camera',
        src.includes("/\\babove (?:her|him|them)\\b/i.test(String(w.state || '')")
        && src.includes("p.prompt.replace(/\\beye level\\b/i, 'from above')"));
}

// ---------------------------------------------------------------- NanoGPT backend (0.37.0)
{
    check('src: nanogpt backend registered in the switch and the UI',
        src.includes("case 'nanogpt': return generateNanogpt(")
        && src.includes('value="nanogpt"') && src.includes('snapshot_nanogpt_key'));
    check('src: nanogpt resolves to natural style (Qwen reads paragraphs, not danbooru)',
        src.includes("['pollinations', 'nanogpt'].includes(settings.backend) ? 'natural' : 'tags';"));
    check('src: nanogpt hits the OpenAI-compatible route with no fabricated negative field',
        src.includes('https://nano-gpt.com/v1/images/generations')
        && src.includes("response_format: 'b64_json'")
        && !/generateNanogpt[\s\S]{0,900}negative_prompt/.test(src));
    check('src: nanogpt key/model survive a defaults reset',
        src.includes("'nanogptKey', 'nanogptModel'"));
    check('src: qwen builder note is nanogpt+natural scoped only',
        src.includes("settings.backend === 'nanogpt' && style === 'natural'"));
    check('src: natural mode welds WITHOUT the danbooru count run (0.38.0)',
        src.includes("if (style === 'natural') {")
        && src.includes("enforceShotGrammar([...id.blocks, bgTag, crowdTag, restPrompt]")
        && src.includes("enforceShotGrammar([nsfwTag, id.counts, ...id.blocks, bgTag, crowdTag, restPrompt]"));
    check('src: tags style on nanogpt warns once per chat',
        src.includes("settings.backend === 'nanogpt' && resolveStyle() === 'tags'")
        && src.includes('nanogpt-tags:'));
    check('src: the composition sentence rides BOTH styles (0.38.0)',
        src.includes("p.sentence ? `${appendAnchor(p.prompt, anchorFor(p))}, ${p.sentence}` : appendAnchor(p.prompt, anchorFor(p)),"));
}

// ---------------------------------------------------------------- parallel render + sentence lying cues (0.39.0)
{
    // Parallel panel rendering with a concurrency cap.
    let peak = 0, active = 0;
    const order = [];
    const res = await S.mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
        active++; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 5));
        active--; order.push(n);
        return n * 10;
    });
    check('parallel: mapLimit preserves order and caps concurrency at 2',
        JSON.stringify(res) === '[10,20,30,40,50,60]' && peak <= 2);
    check('src: panels render via mapLimit, not a sequential for-loop',
        src.includes('panelImages = await mapLimit(panels, 2,'));
    // Lying cues live in sentences too ('head thrown back into pillow').
    check('lying: pillow/futon cues count as lying',
        S.LYING_STATE.test('head thrown back into pillow') && S.LYING_STATE.test('collapsed on the futon'));
    check('src: camera swaps read states AND the sentence',
        src.includes('|| LYING_STATE.test(p.sentence)'));
}

// ---------------------------------------------------------------- framing braces + close-crop ban + nsfw tag (0.40.0)
{
    // Braced framing tags were invisible to shot grammar (field: '{cowboy shot}'
    // matched nothing, the dutch angle ran wild, he vanished from the panel).
    const g = S.enforceShotGrammar('{cowboy shot}, wide shot, dutch angle, from below');
    check('grammar: braced framing counts; second framing and second angle drop',
        g === '{cowboy shot}, dutch angle');
    // Close crops are banned on explicit two-person panels.
    check('framing guard: close-up and upper body become cowboy shot on explicit duos',
        S.explicitFramingGuard('upper body, from below, dramatic lighting', true, 2) === 'cowboy shot, from below, dramatic lighting'
        && S.explicitFramingGuard('close-up, eye level', true, 2) === 'cowboy shot, eye level');
    check('framing guard: SFW and solo frames untouched',
        S.explicitFramingGuard('close-up, eye level', false, 2) === 'close-up, eye level'
        && S.explicitFramingGuard('close-up, eye level', true, 1) === 'close-up, eye level');
    // The literal nsfw tag leads explicit panels in tags mode.
    check('src: nsfw tag prepended on explicit panels in tags mode',
        src.includes("const nsfwTag = (p.explicit && style === 'tags') ? 'nsfw' : '';")
        && src.includes('[nsfwTag, id.counts, ...id.blocks, bgTag, crowdTag, restPrompt]'));
    check('src: the close-crop guard is wired before assembly',
        src.includes('explicitFramingGuard(deduped, p.explicit, principals.length)'));
}

// ---------------------------------------------------------------- crowd vocabulary + style labels (0.41.0)
{
    // The field's anchor population was invisible to a crowd-only regex.
    check('crowd: crowded/students/hundreds hoist',
        /crowded hall of students in formal uniforms/.test(S.hoistCrowdTokens('crowded hall of students in formal uniforms, stone walls', true))
        && /hundreds of seated students/.test(S.hoistCrowdTokens('hundreds of seated students, stone walls', true))
        && /frozen mid-bite/.test(S.extractCrowdTokens('students in formal uniforms frozen mid-bite, dust motes').crowd));
    check('src: prompt styles read as model choices',
        src.includes('>NovelAI (danbooru tags)<') && src.includes('>Natural language (Qwen, FLUX)<'));
}

// ---------------------------------------------------------------- code bubbles + per-chat cast + clear button (0.42.0)
{
    const scene = 'Jovan raised the blade. "LONG LIVE THE THIRTEENTH DIVISION!" The courtyard answered.\n\nRukia stared. "...the division can never know I make that sound," she whispered.';
    const quotes = S.extractSceneQuotes(scene);
    check('quotes: extracted verbatim from the scene, in order',
        quotes.length === 2 && quotes[0].text === 'LONG LIVE THE THIRTEENTH DIVISION!'
        && quotes[1].text === '...the division can never know I make that sound,');
    check('quotes: speaker attributed by nearest preceding cast name',
        S.attributeSpeaker(scene, quotes[0].index, ['Jovan Oda', 'Rukia Kuchiki']) === 'Jovan Oda'
        && S.attributeSpeaker(scene, quotes[1].index, ['Jovan Oda', 'Rukia Kuchiki']) === 'Rukia Kuchiki');
    check('quotes: junk and empties skipped',
        S.extractSceneQuotes('no dialogue here').length === 0);
    check('cap: long quotes cut at sentence end with verbatim prefix',
        S.capBubbleText('word '.repeat(40).trim()).length <= 112);
    check('src: silent panels get scene quotes as backstop after the builder path',
        src.includes('const quotes = extractSceneQuotes(scene);')
        && src.includes('panels[i].bubbles.push({ speaker: attributeSpeaker('));
    check('src: code bubbles never land on speaker-less establishing frames (the "alone" bug)',
        src.includes('if (!(panels[i].who || []).length) continue;'));
    check('src: cast selection is per-chat via chatMetadata, sheets stay global',
        src.includes('chatMetadata?.scenesnap_cast') && src.includes('md.scenesnap_cast = name'));
    check('src: clear cast button exists and clears the active sheet',
        src.includes('id="snapshot_cast_clear"') && src.includes("settings.casts[name] = '';"));
}

// ---------------------------------------------------------------- afterglow composition + steps ceiling (0.44.0)
{
    check('src: afterglow panels are side-by-side by law (stacked contact fuses bodies)',
        src.includes('CONTACT POSTURES') && src.includes('SIDE BY SIDE')
        && src.includes('fuses two bodies into one mass'));
    check('src: NAI steps ceiling is 50 (28 was the free-Opus budget, not the API limit)',
        src.includes('Math.min(Math.max(1, Number(settings.naiSteps) || 28), 50)')
        && src.includes('max="50"'));
}

// ---------------------------------------------------------------- anatomy floor + arched-lying + skin tone (0.45.0)
{
    const blocks = S.anatomyFloor([
        'woman, short black hair, violet eyes, completely nude, small breasts thrust upward',
        'man, white hair, pale-blue eyes, completely nude, buried deep and holding still',
    ], true);
    check('floor: breasts get nipples, each block gets its gendered genital',
        /nipples/.test(blocks[0]) && /pussy/.test(blocks[0]) && /penis, erection/.test(blocks[1]));
    check('floor: never doubles, SFW untouched',
        S.anatomyFloor(['woman, nipples, pussy'], true).join(',') === 'woman, nipples, pussy'
        && S.anatomyFloor(['woman, small breasts'], false).join(',') === 'woman, small breasts');
    check('floor: wired after assembleIdentity', src.includes('id.blocks = anatomyFloor(id.blocks, p.explicit);'));
    // The position-flip camera case: 'back arched to maximum' is lying.
    check('lying: back-arched counts (the from-below swap fires)',
        S.LYING_STATE.test('back arched to maximum') && S.LYING_STATE.test('back arched off futon'));
    // The euphemism dodge is closed.
    check('nsfw: deep-inside and rhythmic-driving are acts now',
        S.SEX_ACT.test('holding deep inside her') && S.SEX_ACT.test('driving rhythmically'));
    // Skin tone is mandatory in cast lines.
    check('src: cast author requires skin tone in every line',
        src.includes('SKIN TONE (fair skin, tanned skin, pale skin, dark skin...)')
        && src.includes('Skin tone is MANDATORY in every line'));
}

// ---------------------------------------------------------------- the opening is sacred (0.46.0)
{
    const scene = '"Moan in Japanese."\n\nRukia\'s glazed eyes found his face through the dark, and he snapped his hips into her and her refusal came apart down the middle.\n\nHe fucked her harder, no build, no mercy, the rhythm punishing.';
    const dropped = S.parsePlan(JSON.stringify({ plan: [{ beat: 'He drives into her with punishing force, her body jolting.', who: ['Jovan Oda'] }] }), 4);
    check('opening: a strip that skips the scene\'s first beat is flagged',
        S.openingBeatMissed(dropped, scene) === true);
    const kept = S.parsePlan(JSON.stringify({ plan: [{ beat: 'He orders her to moan in Japanese and her refusal comes apart.', who: ['Jovan Oda', 'Rukia Kuchiki'] }] }), 4);
    check('opening: a strip that opens on the scene\'s first beat passes',
        S.openingBeatMissed(kept, scene) === false);
    check('opening: empty inputs never flag',
        S.openingBeatMissed(dropped, '') === false && S.openingBeatMissed(null, scene) === false);
    check('src: the opening check is in validatePlan and the law in PLAN_LAWS',
        src.includes('openingBeatMissed(plan, opts.scene)') && src.includes('THE OPENING IS SACRED'));
}

// ---------------------------------------------------------------- the vanishing partner (0.47.0)
{
    const plan = { panels: [
        { beat: 'He drives into her.', who: ['Rukia Kuchiki', 'Jovan Oda'] },
        { beat: 'Her reiatsu erupts off the futon.', follows: 'the pressure builds', who: ['Rukia Kuchiki'] },
        { beat: 'He holds her through the climax.', follows: 'the wave peaks', who: ['Rukia Kuchiki', 'Jovan Oda'] },
    ] };
    check('plan: a solo spectacle frame between two dual frames is the vanishing partner',
        S.validatePlan(plan, ['Rukia Kuchiki', 'Jovan Oda'], 4, {})
            .some(p => p.includes('does not vanish mid-scene')));
    check('plan: a solo frame between two OTHER solo frames is fine',
        !S.validatePlan({ panels: [
            { beat: 'He raises the blade.', who: ['Jovan Oda'] },
            { beat: 'She chants.', follows: 'the blade is up', who: ['Rukia Kuchiki'] },
            { beat: 'He lowers the blade.', follows: 'the chant dies', who: ['Jovan Oda'] },
        ] }, ['Rukia Kuchiki', 'Jovan Oda'], 4, {}).some(p => p.includes('vanish')));
}

// ---------------------------------------------------------------- seed before validate; repairs never drop people (0.47.1)
{
    const seedIdx = src.indexOf('who-names missing from cast — targeted seeding');
    const valIdx = src.indexOf('const schemaSent = maxPanels > 1 || structuredSingle;');
    check('src: targeted seeding runs BEFORE plan validation',
        seedIdx !== -1 && valIdx !== -1 && seedIdx < valIdx);
    check('src: a plan repair that drops people is rejected by definition',
        src.includes('whoCount(panelsFix) >= whoCount(panels)')
        && src.includes('plan repair dropped people — rejected'));
}

// ---------------------------------------------------------------- source-level invariants
{
    check('src: single-panel bubble mode requests strict JSON', src.includes('exactly one panel'));
    check('src: overlay failures ship the clean panel', src.includes('bubble overlay failed, shipping the clean panel'));
    check('src: no direct cross-origin fetch to NovelAI remains',
        !src.includes("fetch('https://image.novelai.net"));
    check('src: strip panels generate landscape (flag threaded to every panel backend)',
        src.includes('generateWithBackend(finals[i], negFull, panels.length > 1, seedForPanel')
        && src.includes('generateRunware(positive, negative, landscape, seed)')
        && src.includes('generateNovelAI(positive, negative, landscape, seed)')
        && src.includes('generatePollinations(positive, negative, landscape, seed)')
        && src.includes('if (landscape && p.height > p.width)'));
    check('src: dialogue fills both voices by default', src.includes('Use TWO lines whenever the beat has two voices'));
    check('src: run seed feeds who-derived per-panel seeds through all three backends',
        src.includes('const runSeed = Math.floor(Math.random() * 2 ** 31);')
        && src.includes('seedForPanel(runSeed, (p.who || []).map(w => w.name), p.welded)')
        && src.includes('seed: Number.isInteger(seed) ? seed : -1,')
        && src.includes('seed: Number.isInteger(seed) ? seed : undefined,')
        && src.includes('Number.isInteger(seed) ? seed : Math.floor'));
    check('src: stitch is a rigid cover-filled grid with framed cells',
        src.includes('cx.drawImage(img2, sx, sy, sw, sh, gutter, y, cellW, cellH)') && src.includes('cx.strokeRect(gutter + 2'));
    check('src: world derived once as data and stamped onto every panel by code',
        src.includes('"setting":"<location/environment/population tags') && src.includes('appendAnchor(p.prompt, anchorFor(p))')
        && src.includes('mineDressTags(getActiveCastSheet())'));
    check('src: public address is speaker + attending group, never a private two-shot',
        src.includes('never a private two-shot for a public address'));
    check('src: panel discipline — chronology+climax, continuity, both parties via who, TWO-cap as model physics',
        src.includes('MUST be one of the panels') && src.includes('strict chronological order')
        && src.includes("carry the previous panel's consequences forward")
        && src.includes('BOTH parties in "who"')
        && src.includes('AT MOST TWO') && src.includes('SPLIT into consecutive panels')
        && src.includes('jobs, not outfits')
        && src.includes('oriented toward whoever they address'));
    check('src: the two-cap is enforced in code at parse',
        src.includes('.filter(w => w.name).slice(0, 2) : [];')
        && src.includes('for (const entry of (who || []).slice(0, 2))'));
    check('src: the crowd lives in the setting, not in the tag run (0.21.0 revert)',
        !src.includes('`crowd in ${crowdDress}`')
        && src.includes("const anchorFor = (p) => [setting, dressForPanel(dress, p?.explicit)].filter(Boolean).join(', ');")
        && src.includes("that population's dress"));
    check('src: crowd hoist is token-driven by CROWD_ANCHOR_TOKEN (0.26.0/0.29.0)',
        src.includes('CROWD_ANCHOR_TOKEN.test(t)'));
    check('src: an establishing frame leads with crowd words, never a headcount (0.28.0 — egg-heads reverted)',
        !src.includes("6+boys, 6+girls, crowd")
        && src.includes("crowdHere ? hoistCrowdTokens(anchorText, true) : ''"));
    check('src: V4.5 Curated + explicit panel warns once (the silent NSFW kill)',
        src.includes("/curated/i.test(String(settings.naiModel || ''))")
        && src.includes('EXPLICIT_STATE.test(String(w?.state'));
    check('src: stacked size cues cannot shrink an adult into a child',
        src.includes('SIZE_WORD.test(low) && SIZE_WORD.test(String(blockTags')
        && src.includes('const SIZE_NOUN ='));
    check('src: shot grammar is enforced in code, not merely mandated in prose',
        src.includes('p.prompt = enforceShotGrammar(') && src.includes('function enforceShotGrammar(prompt)'));
    check('src: the anti-modern negative covers the school-uniform prior and architecture',
        src.includes('school uniform, gakuran, blazer, pleated skirt') && src.includes('glass building, concrete building'));
    check('src: state is pose and feeling only — counts and garments are code-owned',
        src.includes('Never a count tag (1boy, 1girl, 2boys, solo) and never a garment')
        && src.includes('if (CODE_OWNED_TAG.test(low)) continue;'));
    check('src: a crowd frame is legal — the retry targets omission, not absent principals',
        src.includes('const whoOmitted = ps => ps.reduce((n, p) => n + (p.whoDeclared ? 0 : 1), 0);')
        && src.includes('whoDeclared: Array.isArray(p?.who),')
        && src.includes("(establishing frame — crowd is the subject)")
        && !src.includes('whoCoverage'));

    check('src: garments and transient activity are enforced, not merely mandated',
        src.includes('if (hasGarment(low) && !GARMENT_CONDITION.test(low)) continue;')
        && src.includes('stripTransientFromSetting(capTags(obj?.setting, 16))'));
    check('src: who-membership is ONE rule with no counter-rule pulling against it',
        src.includes("WHO IS THE PEOPLE THE BEAT'S ACTION PASSES BETWEEN")
        && src.includes('Never pad a frame to two, and never cut a frame to one.')
        && src.includes('"who": [] is reserved for scenes with NO named characters present, and must still be PRESENT')
        && src.includes('ONE BEAT PER PANEL, and every panel a DIFFERENT beat')
        // the rule this one replaced pulled the opposite way and produced an all-solo strip
        && !src.includes('Defaulting everything to solo is a failed strip')
        && !src.includes('BOTH principals must share ONE interaction'));
    check('src: diacritics folded and sentences cut at a boundary, both wired in',
        src.includes('built = foldTagDiacritics(built);')
        && src.includes('sentence: capSentenceSafe(stripLayoutMeta('));
    check('src: variety boost is off for strips — a strip is one continuous place',
        src.includes('variety_boost: !landscape,'));

    check('src: auto-build describes bodies, never characters by name',
        src.includes('NO CHARACTER NAMES IN THE TAGS, EVER') && src.includes('Describe the BODY')
        && src.includes('RANK IS NOT AN OUTFIT, in the cast line either'));
    check('src: the plan rides in the SAME call as the panels — no second round trip',
        src.includes('const PLAN_LAWS = `') && src.includes('PLAN FIRST, IN THE SAME ANSWER')
        && src.includes('plan = parsePlan(raw, maxPanels);')
        && src.includes('validatePlan(plan, castNames, maxPanels, { crowd: wantsCrowd, beatCount, scene })')
        && src.includes('YOUR PLAN WAS REJECTED:')
        && !src.includes('const planRaw = await callLLM'));
    check('src: only a plan that fails validation costs an extra call',
        src.split('await callLLM(').length - 1 === 8);
    check('src: beats must chain — a panel states how it follows the one before it',
        src.includes('THE BEATS ARE A CHAIN, NOT A LIST')
        && src.includes('STRICT CHRONOLOGY') && src.includes('does not say how it follows panel'));
    check('src: no character or work name reaches the tags',
        src.includes('NO CHARACTER NAMES IN THE TAGS, EVER')
        && src.includes('stripRankInsignia(stripNameTags(hit.tags, hit.name))')
        && !src.includes('kuchiki rukia'));
    check('src: the plan owns the world, and is surfaced in the debug popup',
        src.includes('if (plan.setting) panels.setting = stripTransientFromSetting(plan.setting);')
        && src.includes("'PLAN — (single-call builder; no plan pass)'"));
    check('src: rank decorations are stripped at the weld and the WWII prior is negated',
        src.includes('function stripRankInsignia(') && src.includes('RANK_WORD.test(t) && DECORATION_WORD.test(t)')
        && src.includes('nazi, swastika, iron cross'));
    check('src: the count run follows block order',
        src.includes('const counts = seen.map(k => label(k, nOf(k))).join(\', \');')
        && src.includes('[nsfwTag, id.counts, ...id.blocks, bgTag, crowdTag, restPrompt]'));
    check('src: anchor owns the environment — dedupe wired into BOTH panel paths',
        (src.match(/dedupeAgainstAnchor\(/g) || []).length >= 3
        && src.includes('const bgTag = background.length ? backgroundFigureTag(background, activeSheet) : \'\';'));
    check('src: crowd hoist repositions the anchor\'s words AND the prompt\'s crowd actions (0.29.0)',
        src.includes('const cx = extractCrowdTokens(deduped);')
        && src.includes("[hoistCrowdTokens(anchorText, true), cx.crowd].filter(Boolean).join(', ')"));
    check('src: a crowd-restoring repair is accepted on an equal score',
        src.includes('const crowdRestored = wantsCrowd')
        && src.includes('fixProblems.length < problems.length || (crowdRestored && fixProblems.length <= problems.length)'));
    check('src: a two-shot must name what passes between the pair, and no lone repeat',
        src.includes('without saying what passes between them')
        && src.includes('Never give the same lone character two panels in a row')
        && src.includes('"between":"<what passes between them; required when who has two names>"'));
    check('src: bubbles can only be spoken by someone drawn in the frame',
        src.includes('function sanitizeBubbles(list, sceneText, who)')
        && src.includes('if (!speakerPresent(speaker)) continue;')
        && src.includes('sanitizeBubbles(p?.bubbles, sceneText, who)'));
    check('src: the crowd signal drives the establishing frame, and background figures are demoted',
        src.includes('const crowdHere = framesCrowd(anchorText) || framesCrowd(p.prompt);')
        && src.includes('const { principals, background } = splitPrincipals(p.who);'));
    check('src: laws match enforcement — background demotion, speaker presence, standing setting',
        src.includes('A character drawn far away, tiny, or as a silhouette is NOT in "who"')
        && src.includes('Only a character in THIS panel\'s "who" may speak in this panel')
        && src.includes('"setting" is a STANDING description')
        && !src.includes('the extension appends a placement tag'));
    check('src: explicit scenes are tagged explicitly, anatomy locked to cast sheet',
        src.includes('EXPLICIT SCENES:') && src.includes('never euphemize') && src.includes('fullSystem += NSFW_RULE;'));
    check('src: placeholders are empty slots at every gate — detection, author skip-list, merge',
        src.includes('if (!entry || isPlaceholderTags(entry.tags)) missingAll.add(w.name);')
        && src.includes('stripPlaceholderLines(getActiveCastSheet())')
        && src.includes('mergeCastLines(stripPlaceholderLines(String(settings.casts[cast]'));
    check('src: Canon Grounding wiki appearances feed the cast author, guarded and read-only',
        src.includes('canon_grounding_cache') && src.includes('e?.sections?.physical')
        && src.includes('CANON WIKI DATA (authoritative appearances'));
    check('src: appearance source order — wiki, then story, then canon knowledge; unknown reserved for OCs',
        src.includes('APPEARANCE SOURCE ORDER') && src.includes('canon characters are never "unknown"')
        && src.includes('strictly for ORIGINAL characters'));
    check('src: missing who-names trigger targeted seeding, then names are scrubbed from sentences',
        src.includes('REQUIRED CHARACTERS (output a line for EACH')
        && src.includes('autoBuildCast({ silent: true, requiredNames: [...missingAll] })')
        && src.includes('p.sentence = replaceNamesInSentence(p.sentence, activeSheet);'));
    check('src: dress-derived anti-modern negative wired into the strip loop',
        src.includes('antiModernNegative(dress) ? `${negative}, ${antiModernNegative(dress)}` : negative')
        && src.includes('generateWithBackend(finals[i], negFull,'));
    check('src: dialogue beats are two-shots and bubbles show the speaker\'s face',
        src.includes('BOTH are in "who"; cropping the other one out is a failed panel')
        && src.includes("SHOW ITS SPEAKER'S FACE")
        && src.includes('A two-person exchange may play as a shot/reverse-shot pair across two panels.'));
    check('src: welded panels share the run seed (one place); the who-hash backstops unwelded ones',
        src.includes('seedForPanel(runSeed, (p.who || []).map(w => w.name), p.welded)')
        && src.includes('if (identityWelded) return (runSeed >>> 0) % 2147483647;')
        && src.includes('p.welded = id.blocks.length > 0;'));
    check('src: crowd dress is named in setting by contract',
        src.includes("that population's dress"));
    check('src: gold-run cinematography mandated — shot grammar, variety, acting density',
        src.includes('SHOT GRAMMAR') && src.includes('NEVER repeat the same framing+angle pair')
        && src.includes('ACTING DENSITY') && src.includes('A two-tag state is a failed panel'));
    check('src: active cast is global — per-chat divergence removed',
        src.includes('settings.activeCast') && !src.includes('chatMetadata?.sceneSnapCast'));
    check('src: hybrid natural-language sentence — schema, contract, and append in EVERY style',
        src.includes('"sentence":"<ONE plain-English sentence')
        && src.includes('where natural language earns its keep')
        && src.includes('p.sentence ? `${appendAnchor(p.prompt, anchorFor(p))}, ${p.sentence}`'));
    check('src: state purity is enforced in code, not requested',
        src.includes('function scrubState(') && src.includes('stripRankInsignia(scrubState(state, tags, EXPLICIT_STATE.test(state) ? 420 : 200))'));
    check('src: state is bound to its owner by schema and weld',
        src.includes('"state":"<THIS character') && src.includes('welds their state onto it')
        && src.includes("carries it in their OWN \"state\"")
        && src.includes('const scrubbed = stripRankInsignia(scrubState(state, tags, EXPLICIT_STATE.test(state) ? 420 : 200));')
        && src.includes('const dressed = applyUndress(tags, scrubbed);')
        && src.includes('blocks.push([dressed, clothing, scrubbed].filter(Boolean).join(\', \'));'));
    check('src: setting and dress are tag-capped in code',
        src.includes('capTags(obj?.setting, 16)') && src.includes('capTags(obj?.dress, 8)'));
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
        && src.includes('whoOmitted(panels2) < whoOmitted(panels)')
        && src.includes('(builder omitted the who field)'));
    check('src: contract v5.1 — who owns identity AND state; builder writes neither identity nor per-character detail into the shared prompt',
        src.includes('WHO writes identity AND owns state, and WHO is not you')
        && src.includes('one contiguous run per character')
        && src.includes('a climax panel whose victim is missing from "who" is a failed panel')
        && src.includes('assembleIdentity(principals, activeSheet, { dress: firstGarmentTag(dress), worldDress: dress })')
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
    check('src: name escaping is the canonical top-level escRe — no $item, no tab corruption',
        src.includes('const escRe = s => String(s).replace(') && src.includes('${escRe(token)}')
        && !src.includes('$item')
        && S.escRe('(') === '\\(' && S.escRe('t') === 't' && S.escRe('Matsumoto') === 'Matsumoto'
        && S.escRe('a\\b') === 'a\\\\b' && S.escRe(']') === '\\]');
    check('src: structured single frame — identity is code in EVERY mode',
        src.includes('SINGLE FRAME (active):') && src.includes('const structuredSingle = maxPanels === 1')
        && src.includes('expectJson: structuredSingle') && src.includes("style === 'tags' && castEntryCount > 0"));
    check('src: who-retry fires only when the who schema was actually sent',
        src.includes('const schemaSent = maxPanels > 1 || structuredSingle;')
        && src.includes('panels.length && schemaSent && whoOmitted(panels) && castEntryCount'));
    check('src: FRAME_LAWS is canonical — defined once, cited by exactly the two builder modes',
        src.includes('const FRAME_LAWS = `') && src.split('${FRAME_LAWS}').length - 1 === 2);
    check('src: debug WHO line is honest when the schema was not sent',
        src.includes('(single frame — builder-written identity)'));
    check('src: version stamp matches manifest', (() => {
        const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf-8'));
        const m = src.match(/const VERSION = '([^']+)'/);
        return m && m[1] === manifest.version;
    })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

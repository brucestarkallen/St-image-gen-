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
    'stripScene', 'isCorsProxyDisabled', 'explainError', 'isStaleSession', 'classifyFetchDeath',
];

const prelude = `
const defaultSettings = Object.freeze({
    forcedTags: 'masterpiece, best quality, absurdres, detailed background',
    negativePrompt: 'lowres',
    stripPatterns: '<details>[\\\\s\\\\S]*?</details>\\n\\\\{[A-Z_]+\\\\}[\\\\s\\\\S]*?\\\\{/[A-Z_]+\\\\}\\n<!--[\\\\s\\\\S]*?-->',
});
const BACKEND_QUALITY = { novelai: 'very aesthetic, masterpiece, no text, detailed background' };
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
    check('bubbles: verify-then-trim — long verbatim line kept and word-safe cut <= 90',
        trimmed.length === 1 && trimmed[0].text.length <= 90 && !trimmed[0].text.endsWith(' '));

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

// ---------------------------------------------------------------- CORS-proxy guard
{
    check('cors-guard: ST disabled-proxy 404 detected',
        S.isCorsProxyDisabled(404, 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.'));
    check('cors-guard: real upstream 404 not misclassified',
        !S.isCorsProxyDisabled(404, '{"statusCode":404,"message":"Not Found"}'));
    check('cors-guard: message without 404 status not misclassified',
        !S.isCorsProxyDisabled(500, 'CORS proxy is disabled'));
    check('cors-guard: empty body tolerated', !S.isCorsProxyDisabled(404, ''));
}

// ---------------------------------------------------------------- fetch-death classification
{
    check('death: server unreachable -> null (unreachable message owns it)', S.classifyFetchDeath(false) === null);
    const blocked = S.classifyFetchDeath(true);
    check('death: server up -> blocked-in-browser error with flag',
        blocked instanceof Error && blocked.blockedInBrowser === true && /blocker|shield/i.test(blocked.message));
    check('death: blocked message never claims the server is down', !/restarting|down/i.test(blocked.message.replace('shields', '')));
}

// ---------------------------------------------------------------- stale-session guard
{
    // Body captured verbatim from a live ST instance rejecting a stale CSRF token.
    const LIVE_403 = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>ForbiddenError: Invalid CSRF token. Please refresh the page and try again.</pre>\n</body>\n</html>\n';
    check('stale: live ST 403 body detected', S.isStaleSession(403, LIVE_403));
    check('stale: other 403s not misclassified', !S.isStaleSession(403, 'Forbidden: whitelist'));
    check('stale: marker without 403 not misclassified', !S.isStaleSession(500, LIVE_403));
    check('stale: empty tolerated', !S.isStaleSession(403, ''));
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

// ---------------------------------------------------------------- source-level invariants
{
    check('src: single-panel bubble mode requests strict JSON', src.includes('exactly one panel'));
    check('src: overlay failures ship the clean panel', src.includes('bubble overlay failed, shipping the clean panel'));
    check('src: no direct cross-origin fetch to NovelAI remains',
        !src.includes("fetch('https://image.novelai.net"));
    check('src: proxy target is percent-encoded into the path',
        src.includes('/proxy/${encodeURIComponent(NAI_IMAGE_ENDPOINT)}') && !src.includes('/proxy/${NAI_IMAGE_ENDPOINT}'));
    check('src: fetch death is classified by probing /version, not assumed',
        src.includes("fetch('/version'") && src.includes('classifyFetchDeath(await probeServerUp())'));
    check('src: generateRaw fallback precedes quiet prompt',
        src.indexOf('ctx.generateRaw') !== -1 && src.indexOf('ctx.generateRaw') < src.indexOf('ctx.generateQuietPrompt'));
    check('src: version stamp matches manifest', (() => {
        const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf-8'));
        const m = src.match(/const VERSION = '([^']+)'/);
        return m && m[1] === manifest.version;
    })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

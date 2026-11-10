// Pure helpers for scripts/compare-providers.js: flag parsing, the comparison
// rules, the summary numbers and the HTML report. No network, no Firebase, no
// AI calls in here, so all of it is unit-tested.

const PROVIDERS = ['gemini', 'claude'];

// Estimate only. Published claude-opus-5-5 rates, US dollars per million tokens.
const CLAUDE_PRICE_MODEL = 'claude-opus-5-5';
const CLAUDE_INPUT_PER_MILLION = 4;
const CLAUDE_OUTPUT_PER_MILLION = 20;

function parseArgs(argv) {
  const args = {
    limit: 10,
    dryRun: false,
    since: '',
    providers: [...PROVIDERS],
    ids: [],
    claudeModel: '',
    claudeEffort: '',
    out: '',
    delayMs: 1500,
    retryFailed: false,
    reportOnly: false,
  };

  const list = (value) => String(value || '').split(',').map((part) => part.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${current} needs a value`);
      return value;
    };
    if (current === '--limit') args.limit = Number.parseInt(next(), 10);
    else if (current === '--dry-run') args.dryRun = true;
    else if (current === '--since') args.since = next();
    else if (current === '--providers') args.providers = list(next());
    else if (current === '--ids' || current === '--id') args.ids.push(...list(next()));
    else if (current === '--claude-model') args.claudeModel = next();
    else if (current === '--claude-effort') args.claudeEffort = next();
    else if (current === '--out') args.out = next();
    else if (current === '--delay-ms') args.delayMs = Number.parseInt(next(), 10);
    else if (current === '--retry-failed') args.retryFailed = true;
    else if (current === '--report-only') args.reportOnly = true;
    else if (current.startsWith('--')) throw new Error(`Unknown flag: ${current}`);
    else args.ids.push(current);
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('--limit must be a positive number');
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be zero or more');
  if (args.providers.length === 0) throw new Error('--providers needs at least one of: gemini, claude');
  const unknown = args.providers.filter((name) => !PROVIDERS.includes(name));
  if (unknown.length) throw new Error(`Unknown provider: ${unknown.join(', ')} (use gemini, claude)`);
  if (args.since && Number.isNaN(new Date(args.since).getTime())) throw new Error(`--since is not a date: ${args.since}`);
  args.providers = PROVIDERS.filter((name) => args.providers.includes(name));
  args.ids = [...new Set(args.ids)];
  return args;
}

// ---------- comparison rules ----------

function toAmount(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Money is compared as numbers, to the cent: 12.5, "12.50" and 12.499999 agree.
function sameAmount(a, b) {
  const x = toAmount(a);
  const y = toAmount(b);
  if (x == null || y == null) return x == null && y == null;
  return Math.round(x * 100) === Math.round(y * 100);
}

function toDay(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const iso = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Dates are compared as calendar days, not as text: "2026-8-5" equals "2026-08-05".
function sameDate(a, b) {
  const x = toDay(a);
  const y = toDay(b);
  if (x == null || y == null) return x == null && y == null && (a == null || a === '') && (b == null || b === '');
  return x === y;
}

function merchantKey(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

// Loose on purpose: case, accents, spacing and punctuation are ignored.
// Returns 'same', 'close' (one name contains the other) or 'different'.
function merchantMatch(a, b) {
  const x = merchantKey(a);
  const y = merchantKey(b);
  if (!x || !y) return !x && !y ? 'same' : 'different';
  if (x === y) return 'same';
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.includes(short) ? 'close' : 'different';
}

function itemCount(view) {
  if (!view) return null;
  if (Array.isArray(view.items)) return view.items.length;
  return view.itemCount ?? null;
}

// Compare one answer against the reference (the stored Firestore value).
function compareToReference(reference, answer) {
  const merchant = merchantMatch(reference.merchant, answer.merchant);
  return {
    date: sameDate(reference.date, answer.date),
    total: sameAmount(reference.total, answer.total),
    tax: sameAmount(reference.tax, answer.tax),
    itemCount: itemCount(reference) === itemCount(answer),
    merchant, // 'same' | 'close' | 'different': flagged, never a hard failure
  };
}

/**
 * Work out everything the report needs for one receipt.
 * hard = a provider failed, or disagrees with the stored value on date or total,
 *        or the two providers disagree with each other on date or total.
 * soft = merchant name, tax or item count differ.
 */
function compareReceipt(result) {
  const stored = result.stored || {};
  const providers = {};
  let hard = 0;
  let soft = 0;

  for (const name of PROVIDERS) {
    const answer = result.providers && result.providers[name];
    if (!answer) continue;
    if (!answer.ok) {
      providers[name] = { failed: true };
      hard += 1;
      continue;
    }
    const match = compareToReference(stored, answer);
    providers[name] = { failed: false, ...match };
    if (!match.date) hard += 1;
    if (!match.total) hard += 1;
    if (match.merchant !== 'same') soft += 1;
    if (!match.tax) soft += 1;
    if (!match.itemCount) soft += 1;
  }

  const gemini = result.providers && result.providers.gemini;
  const claude = result.providers && result.providers.claude;
  let providersDisagree = false;
  if (gemini && claude && gemini.ok && claude.ok) {
    providersDisagree = !sameDate(gemini.date, claude.date) || !sameAmount(gemini.total, claude.total);
    if (providersDisagree) hard += 1;
  }

  return { providers, providersDisagree, hard, soft, anyDisagreement: hard + soft > 0 };
}

// Rows with any disagreement first (date/total problems before name-only ones),
// then newest first.
function sortResults(results) {
  return results
    .map((result) => ({ result, comparison: compareReceipt(result) }))
    .sort((a, b) => {
      if (b.comparison.hard !== a.comparison.hard) return b.comparison.hard - a.comparison.hard;
      if (b.comparison.soft !== a.comparison.soft) return b.comparison.soft - a.comparison.soft;
      return String(b.result.createdAt || '').localeCompare(String(a.result.createdAt || ''));
    });
}

function estimateClaudeCost(inputTokens, outputTokens) {
  return (inputTokens / 1e6) * CLAUDE_INPUT_PER_MILLION + (outputTokens / 1e6) * CLAUDE_OUTPUT_PER_MILLION;
}

function summarize(results) {
  const summary = { receipts: results.length, providers: {} };
  for (const name of PROVIDERS) {
    const stats = {
      attempted: 0, failures: 0, date: 0, total: 0, merchant: 0, merchantClose: 0,
      ms: 0, calls: 0, inputTokens: 0, outputTokens: 0, models: [],
    };
    for (const result of results) {
      const answer = result.providers && result.providers[name];
      if (!answer) continue;
      stats.attempted += 1;
      stats.ms += answer.ms || 0;
      stats.calls += answer.calls || 0;
      stats.inputTokens += answer.inputTokens || 0;
      stats.outputTokens += answer.outputTokens || 0;
      for (const model of answer.models || []) if (!stats.models.includes(model)) stats.models.push(model);
      if (!answer.ok) { stats.failures += 1; continue; }
      const match = compareToReference(result.stored || {}, answer);
      if (match.date) stats.date += 1;
      if (match.total) stats.total += 1;
      if (match.merchant === 'same') stats.merchant += 1;
      if (match.merchant === 'close') stats.merchantClose += 1;
    }
    stats.averageMs = stats.attempted ? Math.round(stats.ms / stats.attempted) : 0;
    if (name === 'claude') stats.estimatedCost = estimateClaudeCost(stats.inputTokens, stats.outputTokens);
    summary.providers[name] = stats;
  }
  return summary;
}

function tallyLine(results) {
  const summary = summarize(results);
  const parts = [`${summary.receipts} done`];
  for (const name of PROVIDERS) {
    const s = summary.providers[name];
    if (!s.attempted) continue;
    parts.push(`${name}: date ${s.date}/${s.attempted}, total ${s.total}/${s.attempted}, failed ${s.failures}`);
  }
  return parts.join(' | ');
}

// ---------- HTML report ----------

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value) {
  const n = toAmount(value);
  return n == null ? 'none' : n.toFixed(2);
}

function seconds(ms) {
  return `${((ms || 0) / 1000).toFixed(1)} s`;
}

const LABELS = { stored: 'Stored', gemini: 'Gemini', claude: 'Claude' };

function field(label, text, state) {
  const cls = state === 'bad' ? ' class="bad"' : state === 'flag' ? ' class="flag"' : '';
  return `<div class="field"><span class="label">${escapeHtml(label)}</span> <span${cls}>${escapeHtml(text)}</span></div>`;
}

function itemsBlock(view) {
  const items = Array.isArray(view.items) ? view.items : [];
  if (items.length === 0) return '';
  const rows = items.map((item) => {
    const quantity = item.quantity && item.quantity !== 1 ? ` x${escapeHtml(item.quantity)}` : '';
    return `<li>${escapeHtml(item.name)}${quantity} <span class="price">${escapeHtml(money(item.price))}</span></li>`;
  }).join('');
  return `<details><summary>${items.length} item${items.length === 1 ? '' : 's'}</summary><ul class="items">${rows}</ul></details>`;
}

function answerCell(view, match) {
  const state = (ok, soft) => (match && !ok ? (soft ? 'flag' : 'bad') : '');
  const merchantState = match && match.merchant !== 'same' ? 'flag' : '';
  const merchantNote = match && match.merchant === 'close' ? ' (close)' : '';
  const lines = [
    field('Merchant', `${view.merchant ?? 'none'}${merchantNote}`, merchantState),
    field('Date', view.date ?? 'none', state(match && match.date, false)),
    field('Total', money(view.total), state(match && match.total, false)),
    field('Tax', money(view.tax), state(match && match.tax, true)),
    field('Items', itemCount(view) ?? 'none', state(match && match.itemCount, true)),
  ];
  if (view.confidence != null) lines.push(field('Confidence', view.confidence, ''));
  return lines.join('') + itemsBlock(view);
}

function providerCell(name, answer, match) {
  if (!answer) return '<td class="muted">Not run</td>';
  const models = (answer.models || []).join(', ');
  const meta = `<div class="meta">${escapeHtml(seconds(answer.ms))}, ${answer.calls || 0} call${answer.calls === 1 ? '' : 's'}`
    + `${models ? `, ${escapeHtml(models)}` : ''}`
    + `, ${answer.inputTokens || 0} in / ${answer.outputTokens || 0} out tokens</div>`;
  if (!answer.ok) {
    return `<td><div class="bad">Failed: ${escapeHtml(answer.error || 'unknown error')}</div>${meta}</td>`;
  }
  return `<td>${answerCell(answer, match)}${meta}</td>`;
}

function receiptRow({ result, comparison }, loadImage) {
  const thumbs = (result.thumbs || []).map((file) => {
    const src = loadImage ? loadImage(file) : '';
    return src ? `<img src="${escapeHtml(src)}" alt="Receipt photo">` : '<div class="muted">Photo not saved</div>';
  }).join('');
  const notes = [];
  if (comparison.providersDisagree) notes.push('Gemini and Claude disagree on date or total');
  if (!comparison.anyDisagreement) notes.push('All agree');
  const rowClass = comparison.hard ? 'hard' : comparison.soft ? 'soft' : 'clean';

  return `<tr class="${rowClass}">
<td class="photo">${thumbs || '<div class="muted">No photo</div>'}
<div class="meta">${escapeHtml(result.id)}<br>${escapeHtml(toDay(result.createdAt) || '')}</div>
${notes.map((note) => `<div class="note">${escapeHtml(note)}</div>`).join('')}</td>
<td>${answerCell(result.stored || {}, null)}</td>
${providerCell('gemini', result.providers && result.providers.gemini, comparison.providers.gemini)}
${providerCell('claude', result.providers && result.providers.claude, comparison.providers.claude)}
</tr>`;
}

function summaryTable(summary, meta) {
  const cell = (name, render) => {
    const stats = summary.providers[name];
    return `<td>${stats.attempted ? escapeHtml(render(stats)) : 'Not run'}</td>`;
  };
  const row = (label, render) => `<tr><th scope="row">${escapeHtml(label)}</th>${cell('gemini', render)}${cell('claude', render)}</tr>`;
  const of = (n, s) => `${n} of ${s.attempted}`;
  const claude = summary.providers.claude;
  const claudeModel = (meta && meta.claudeModel) || CLAUDE_PRICE_MODEL;
  const rateNote = claudeModel === CLAUDE_PRICE_MODEL ? '' : ` This run used ${claudeModel}, so the real cost will differ.`;
  const cost = claude.attempted
    ? `<p>Estimated Claude cost for this run: $${claude.estimatedCost.toFixed(4)}`
      + `${claude.attempted ? ` (about $${(claude.estimatedCost / claude.attempted).toFixed(4)} per receipt)` : ''}.`
      + ` This is an estimate from token counts at $${CLAUDE_INPUT_PER_MILLION} per million input tokens and`
      + ` $${CLAUDE_OUTPUT_PER_MILLION} per million output tokens for ${CLAUDE_PRICE_MODEL}, not a bill.${escapeHtml(rateNote)}</p>`
    : '';

  return `<table class="summary">
<thead><tr><th></th><th>Gemini</th><th>Claude</th></tr></thead>
<tbody>
${row('Receipts run', (s) => String(s.attempted))}
${row('Date matched stored', (s) => of(s.date, s))}
${row('Total matched stored', (s) => of(s.total, s))}
${row('Merchant matched stored', (s) => `${of(s.merchant, s)}${s.merchantClose ? `, plus ${s.merchantClose} close` : ''}`)}
${row('Failures', (s) => String(s.failures))}
${row('Average time', (s) => seconds(s.averageMs))}
${row('AI calls', (s) => String(s.calls))}
${row('Models used', (s) => s.models.join(', ') || 'unknown')}
${row('Tokens in / out', (s) => `${s.inputTokens} / ${s.outputTokens}`)}
</tbody></table>
${cost}`;
}

const STYLE = `
body { font: 15px/1.45 -apple-system, system-ui, sans-serif; color: #1c1c1c; background: #fafafa; margin: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 8px; }
p { max-width: 70ch; }
table { border-collapse: collapse; background: #fff; }
th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
thead th { background: #f0f0f0; }
table.receipts { width: 100%; table-layout: fixed; }
table.receipts th:first-child { width: 230px; }
tr.hard td.photo { border-left: 4px solid #c0392b; }
tr.soft td.photo { border-left: 4px solid #d99a00; }
.photo img { max-width: 200px; max-height: 320px; display: block; margin-bottom: 6px; border: 1px solid #ccc; }
.field { margin-bottom: 2px; overflow-wrap: anywhere; }
.label { color: #666; }
.bad { background: #fbd9d5; color: #8a1c10; padding: 0 3px; border-radius: 3px; font-weight: 600; }
.flag { background: #fdeebe; color: #6b4b00; padding: 0 3px; border-radius: 3px; }
.meta, .muted { color: #777; font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; }
.note { font-size: 13px; margin-top: 6px; }
details { margin-top: 6px; }
ul.items { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
.price { color: #555; }
`;

/**
 * Build the whole report as one HTML string.
 * @param {Array} results - receipt results as saved in results.json
 * @param {object} meta - { generatedAt, claudeModel, claudeEffort }
 * @param {(file: string) => string} loadImage - returns a data URI for a saved thumbnail, or ''
 */
function renderReport(results, meta = {}, loadImage = null) {
  const sorted = sortResults(results);
  const summary = summarize(results);
  const disagreeing = sorted.filter((row) => row.comparison.anyDisagreement).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt parsing: Gemini and Claude compared</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Receipt parsing: Gemini and Claude compared</h1>
<p>${summary.receipts} receipt${summary.receipts === 1 ? '' : 's'} compared, ${disagreeing} with at least one disagreement.
${meta.generatedAt ? `Report made ${escapeHtml(meta.generatedAt)}.` : ''}</p>
<p>"Stored" is what is saved for the receipt today. It may have been corrected by hand, so it is the closest thing to a right answer, but it can be wrong too.
Red means the date or total differs from the stored value. Yellow means the merchant name, tax or item count differs; merchant names are compared loosely and only flagged.</p>
<h2>Summary</h2>
${summaryTable(summary, meta)}
<h2>Receipts</h2>
<table class="receipts">
<thead><tr><th>Receipt</th><th>${LABELS.stored}</th><th>${LABELS.gemini}</th><th>${LABELS.claude}</th></tr></thead>
<tbody>
${sorted.map((row) => receiptRow(row, loadImage)).join('\n')}
</tbody>
</table>
</body>
</html>
`;
}

module.exports = {
  PROVIDERS,
  parseArgs,
  sameAmount,
  sameDate,
  merchantMatch,
  compareToReference,
  compareReceipt,
  sortResults,
  summarize,
  tallyLine,
  estimateClaudeCost,
  escapeHtml,
  renderReport,
};

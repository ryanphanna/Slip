const fs = require('fs');
const path = require('path');
const {
  parseArgs, sameAmount, sameDate, merchantMatch, compareReceipt, sortResults, summarize,
  estimateClaudeCost, renderReport,
} = require('../scripts/compare-lib');
const { selectWork, providersNeeded } = require('../scripts/compare-providers');

const answer = (overrides = {}) => ({
  ok: true, error: null, merchant: 'IKEA', date: '2026-08-25', total: 20.5, tax: 1.5,
  itemCount: 1, items: [{ name: 'Basket', price: 19, quantity: 1 }], confidence: 0.9,
  ms: 2000, calls: 1, models: ['m'], inputTokens: 1000, outputTokens: 200, ...overrides,
});
const stored = (overrides = {}) => ({
  merchant: 'IKEA', date: '2026-08-25', total: 20.5, tax: 1.5, itemCount: 1,
  items: [{ name: 'Basket', price: 19, quantity: 1 }], confidence: null, ...overrides,
});
const receipt = (id, parts = {}) => ({
  id, createdAt: '2026-09-01T12:00:00.000Z', thumbs: [], stored: stored(),
  providers: { gemini: answer(), claude: answer() }, ...parts,
});

describe('compare-providers flags', () => {
  it('has safe defaults', () => {
    expect(parseArgs([])).toMatchObject({ limit: 10, dryRun: false, since: '', providers: ['gemini', 'claude'], ids: [] });
  });

  it('reads every flag', () => {
    const args = parseArgs(['--limit', '25', '--dry-run', '--since', '2026-09-01', '--providers', 'claude',
      '--ids', 'a,b', '--id', 'c', 'd', '--claude-model', 'claude-sonnet-5-5', '--claude-effort', 'high', '--retry-failed']);
    expect(args).toMatchObject({
      limit: 25, dryRun: true, since: '2026-09-01', providers: ['claude'], ids: ['a', 'b', 'c', 'd'],
      claudeModel: 'claude-sonnet-5-5', claudeEffort: 'high', retryFailed: true,
    });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive/);
    expect(() => parseArgs(['--providers', 'openai'])).toThrow(/Unknown provider/);
    expect(() => parseArgs(['--since', 'last week'])).toThrow(/not a date/);
    expect(() => parseArgs(['--limit'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--write'])).toThrow(/Unknown flag/);
  });
});

describe('comparison rules', () => {
  it('compares totals as numbers, to the cent', () => {
    expect(sameAmount(12.5, '12.50')).toBe(true);
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameAmount('$1,204.10', 1204.1)).toBe(true);
    expect(sameAmount(12.5, 12.51)).toBe(false);
    expect(sameAmount(-12.5, 12.5)).toBe(false);
    expect(sameAmount(null, null)).toBe(true);
    expect(sameAmount(0, null)).toBe(false);
  });

  it('compares dates as dates', () => {
    expect(sameDate('2026-08-05', '2026-8-5')).toBe(true);
    expect(sameDate('2026-08-05', '2026-08-05T14:30:00')).toBe(true);
    expect(sameDate('2026-08-05', 'August 5, 2026')).toBe(true);
    expect(sameDate('2026-08-05', '2024-08-05')).toBe(false);
    expect(sameDate(null, null)).toBe(true);
    expect(sameDate('2026-08-05', null)).toBe(false);
  });

  it('compares merchant names loosely', () => {
    expect(merchantMatch("McDonald's", 'MCDONALDS')).toBe('same');
    expect(merchantMatch('Café Olé', 'cafe ole')).toBe('same');
    expect(merchantMatch('A&W', 'A and W')).toBe('same');
    expect(merchantMatch('Loblaws', 'Loblaws City Market')).toBe('close');
    expect(merchantMatch('Walmart', 'Costco')).toBe('different');
    expect(merchantMatch(null, 'Costco')).toBe('different');
  });

  it('flags a merchant difference without treating it as a hard failure', () => {
    const comparison = compareReceipt(receipt('r1', { providers: { gemini: answer({ merchant: 'Ikea Etobicoke' }), claude: answer() } }));
    expect(comparison.providers.gemini.merchant).toBe('close');
    expect(comparison.hard).toBe(0);
    expect(comparison.soft).toBe(1);
    expect(comparison.anyDisagreement).toBe(true);
  });

  it('counts a wrong date, a wrong total and a failure as hard disagreements', () => {
    const comparison = compareReceipt(receipt('r1', {
      providers: { gemini: answer({ date: '2024-08-25', total: 20.55 }), claude: { ok: false, error: 'declined', ms: 10, calls: 1 } },
    }));
    expect(comparison.providers.gemini).toMatchObject({ date: false, total: false, merchant: 'same' });
    expect(comparison.providers.claude).toEqual({ failed: true });
    expect(comparison.hard).toBe(3);
  });

  it('notices when the two providers disagree with each other', () => {
    const comparison = compareReceipt(receipt('r1', {
      stored: stored({ date: null }),
      providers: { gemini: answer({ date: '2026-08-25' }), claude: answer({ date: '2026-08-26' }) },
    }));
    expect(comparison.providersDisagree).toBe(true);
  });

  it('sorts disagreements first, hard before soft', () => {
    const clean = receipt('clean');
    const soft = receipt('soft', { providers: { gemini: answer({ merchant: 'Other Shop' }), claude: answer() } });
    const hard = receipt('hard', { providers: { gemini: answer({ total: 99 }), claude: answer() } });
    expect(sortResults([clean, soft, hard]).map((row) => row.result.id)).toEqual(['hard', 'soft', 'clean']);
  });

  it('summarizes matches, failures, time, tokens and the Claude cost estimate', () => {
    const summary = summarize([
      receipt('a'),
      receipt('b', { providers: { gemini: answer({ date: '2024-01-01', calls: 2, ms: 4000 }), claude: { ok: false, error: 'x', ms: 1000, calls: 1, inputTokens: 500, outputTokens: 0 } } }),
    ]);
    expect(summary.receipts).toBe(2);
    expect(summary.providers.gemini).toMatchObject({ attempted: 2, failures: 0, date: 1, total: 2, merchant: 2, calls: 3, averageMs: 3000 });
    expect(summary.providers.claude).toMatchObject({ attempted: 2, failures: 1, date: 1, total: 1, inputTokens: 1500, outputTokens: 200 });
    expect(summary.providers.claude.estimatedCost).toBeCloseTo(1500 / 1e6 * 4 + 200 / 1e6 * 20, 10);
    expect(estimateClaudeCost(1e6, 1e6)).toBe(24);
  });
});

describe('resuming a run', () => {
  const candidates = ['n1', 'n2', 'n3', 'n4'].map((id) => ({ id }));

  it('skips receipts already in the results file', () => {
    const saved = [receipt('n1'), receipt('n3')];
    const work = selectWork(candidates, saved, { providers: ['gemini', 'claude'], limit: 10 });
    expect(work.map((item) => item.candidate.id)).toEqual(['n2', 'n4']);
  });

  it('runs only the provider that is still missing', () => {
    const saved = [receipt('n1', { providers: { gemini: answer() } })];
    const work = selectWork(candidates, saved, { providers: ['gemini', 'claude'], limit: 1 });
    expect(work).toEqual([{ candidate: { id: 'n1' }, providers: ['claude'] }]);
  });

  it('retries failures only when asked', () => {
    const failed = receipt('n1', { providers: { gemini: answer(), claude: { ok: false, error: 'x' } } });
    expect(providersNeeded(failed, ['gemini', 'claude'], false)).toEqual([]);
    expect(providersNeeded(failed, ['gemini', 'claude'], true)).toEqual(['claude']);
  });

  it('honours the limit and specific IDs', () => {
    expect(selectWork(candidates, [], { providers: ['claude'], limit: 2 }).map((item) => item.candidate.id)).toEqual(['n1', 'n2']);
    expect(selectWork(candidates, [], { providers: ['claude'], limit: 1, ids: ['n4', 'n2'] }).map((item) => item.candidate.id)).toEqual(['n2', 'n4']);
  });
});

describe('HTML report', () => {
  const results = [
    receipt('clean-one'),
    receipt('bad-one', {
      thumbs: ['images/bad-one-0.jpg'],
      stored: stored({ merchant: 'Tim <Hortons> & Co' }),
      providers: { gemini: answer({ merchant: 'Tim <Hortons> & Co', total: 99 }), claude: { ok: false, error: 'Claude declined', ms: 900, calls: 1, inputTokens: 10, outputTokens: 0 } },
    }),
  ];
  const html = renderReport(results, { generatedAt: '2026-11-09 10:00', claudeModel: 'claude-opus-5-5' }, () => 'data:image/jpeg;base64,AAAA');

  it('is one self-contained page with the summary and a row per receipt', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('2 receipts compared, 1 with at least one disagreement');
    expect((html.match(/<tr class="(hard|soft|clean)">/g) || []).length).toBe(2);
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).not.toMatch(/<script|<link|src="http|href="http/);
    expect(html).toMatch(/estimate from token counts at \$4 per million input tokens and \$20 per million output tokens/);
  });

  it('puts the disagreeing receipt first and highlights it', () => {
    expect(html.indexOf('bad-one')).toBeLessThan(html.indexOf('clean-one'));
    expect(html).toContain('<span class="bad">99.00</span>');
    expect(html).toContain('Failed: Claude declined');
  });

  it('escapes receipt text', () => {
    expect(html).toContain('Tim &lt;Hortons&gt; &amp; Co');
    expect(html).not.toContain('<Hortons>');
  });

  it('has no all-caps styling and no emoji', () => {
    expect(html).not.toMatch(/text-transform/);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('compare-providers.js is read-only', () => {
  it('contains no Firestore or Storage write calls', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'compare-providers.js'), 'utf8');
    expect(source).not.toMatch(/\.(set|update|add|delete|create|save|upload|batch|runTransaction|bulkWriter|makePublic|move|copy)\(/);
    expect(source).not.toMatch(/FieldValue|saveReceipt|saveImages/);
  });
});

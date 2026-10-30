// Turns statement transactions (lib/statements.js) into Slip entries
// (CIV-1186). Pure functions, no Firestore: scripts/upload-statements.js
// loads the data and saves. Ported from the one-time backfill.
//
// A transaction: { account, date, postedDate, description, merchant,
// location, amount (positive = money out), foreignAmount, foreignCurrency,
// kind }. A receipt: a Slip receipt doc with its `id`.

const crypto = require('crypto');
const { normalizeMerchant } = require('./validate');
const { validateImport } = require('./import-schema');
const { VALID_CATEGORIES } = require('./categories');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const cents = (n) => Math.round(n * 100) / 100;
const close = (a, b) => Math.abs(a - b) < 0.005;
const day = (date) => Date.parse(`${date}T00:00:00Z`) / 86400000;
const dayGap = (a, b) => Math.abs(day(a) - day(b));

const BUCKETS = ['spend', 'rent', 'bills', 'cardFees', 'reload', 'transfer', 'income', 'unknown'];
const ADDED_BUCKETS = ['spend', 'rent', 'bills', 'cardFees', 'reload', 'transfer', 'income'];

// Kinds from lib/statements.js -> buckets.
const KIND_BUCKETS = {
  purchase: 'spend', refund: 'spend', rent: 'rent', bill: 'bills', fee: 'cardFees', interest: 'cardFees',
  reload: 'reload', 'card-payment': 'transfer', transfer: 'transfer', cash: 'transfer',
  'etransfer-person': 'transfer', income: 'income', unknown: 'unknown',
};

// Reasons shown on a receipt's statement mark. The first and last match the
// wording saved by the backfill.
const REASONS = {
  otherAmount: 'A card charge from this store has a different amount',
  otherName: 'A card charge for the same amount has a different store name',
  guard: 'A card charge for the same amount a few days away was not added; it may be a second purchase',
};

// Account labels never carry digits ("Simplii No Fee Chequing 8956").
const label = (account) => String(account || '').replace(/\s*\d{3,}\s*/g, ' ').trim();
const lineText = (t) => t.merchant || t.description || '';
const plain = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Rules: { pattern, minAmount?, maxAmount?, merchant?, category?,
// subCategory?, bucket? }. The pattern is case-insensitive regex text tested
// against the description; amounts compare against the amount either way.
// ---------------------------------------------------------------------------
function ruleProblems(rule) {
  const problems = [];
  if (!rule || typeof rule !== 'object') return ['a rule must be an object'];
  if (typeof rule.pattern !== 'string' || !rule.pattern.trim()) problems.push('pattern is required');
  else {
    try { new RegExp(rule.pattern, 'i'); } catch { problems.push('pattern is not a valid regex'); }
  }
  for (const key of ['minAmount', 'maxAmount']) {
    if (rule[key] != null && !Number.isFinite(rule[key])) problems.push(`${key} must be a number`);
  }
  if (rule.bucket != null && !BUCKETS.includes(rule.bucket)) problems.push(`bucket must be one of ${BUCKETS.join(', ')}`);
  if (rule.category != null && !VALID_CATEGORIES.includes(rule.category)) problems.push(`category must be one of ${VALID_CATEGORIES.join(', ')}`);
  for (const key of ['merchant', 'subCategory']) {
    if (rule[key] != null && typeof rule[key] !== 'string') problems.push(`${key} must be text`);
  }
  const known = ['pattern', 'minAmount', 'maxAmount', 'merchant', 'category', 'subCategory', 'bucket'];
  Object.keys(rule).filter((key) => !known.includes(key)).forEach((key) => problems.push(`unknown field ${key}`));
  return problems;
}

// The first rule that fits, or null. Bad rules never fit.
function findRule(t, rules = []) {
  const amount = Math.abs(t.amount);
  return rules.find((rule) => {
    if (ruleProblems(rule).length) return false;
    if (rule.minAmount != null && amount < rule.minAmount - 0.005) return false;
    if (rule.maxAmount != null && amount > rule.maxAmount + 0.005) return false;
    return new RegExp(rule.pattern, 'i').test(t.description || '');
  }) || null;
}

// The bucket for a transaction. Saved rules go first.
function classify(t, rules = []) {
  const rule = findRule(t, rules);
  if (rule && rule.bucket) return rule.bucket;
  const text = t.description || '';
  if (/RETURNED PAYMENT$|CRA REVENUE/i.test(text)) return 'transfer';
  if (/^REGULAR PURCHASES \d/i.test(text)) return 'cardFees';
  if (KIND_BUCKETS[t.kind]) return KIND_BUCKETS[t.kind];
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Store words. Places and statement category words never count.
// ---------------------------------------------------------------------------
const STOP = new Set(('the and inc ltd canada store cafe toronto ontario north york new san francisco montreal vancouver stockholm '
  + 'hamilton washington scarborough mississauga london los angeles seattle chicago boston ottawa quebec etobicoke markham vaughan '
  + 'brampton calgary santa monica buffalo niagara falls retail grocery restaurants hotel entertainment recreation professional '
  + 'financial services transportation personal household expenses health education foreign currency transactions other www com '
  + 'http https online app').split(' '));

const ALIASES = {
  amazon: ['amzn'], uber: ['ubertrip', 'ubereats'], 'tim hortons': ['tims'], mcdonalds: ['mcdonald'],
  loblaws: ['loblaw', 'express'], 'via rail': ['viarail'], simons: ['lamaisonsimons'], shoppers: ['sdm'],
  superstore: ['rcss'], anthropic: ['claude'], 'x (twitter)': ['corp'], 'no frills': ['nofrills'], nofrills: ['frills'],
};

function words(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)));
}

// A receipt's store words, with the names statements use for that store.
function receiptWords(merchant) {
  const found = words(merchant);
  const name = String(merchant || '').toLowerCase().replace(/[’']/g, '');
  for (const [alias, list] of Object.entries(ALIASES)) if (name.includes(alias)) list.forEach((w) => found.add(w));
  return found;
}

// Same word, or one starts the other ("loblaw", "loblaws").
function shareWord(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Already in Slip: a saved `statement` field (on a statement entry or a
// matched receipt) with the same amount and a description sharing a word,
// on the same day or up to 3 days apart (bank exports used the posted date).
// Labels can differ between the Notion ledger and the statement files, so
// the account only counts when the description says nothing. Amounts compare
// either way, since some backfilled chequing lines were saved with the sign
// flipped. A charge already named on a receipt's statement mark counts too.
// Each saved field takes at most one charge, nearest date first. Returns a
// Map transaction -> { doc, how: 'saved' | 'flagged', signFlipped }.
// ---------------------------------------------------------------------------
function alreadyInSlip(transactions, docs) {
  const saved = [];
  for (const doc of docs) {
    if (doc.statement) saved.push({ doc, charge: doc.statement, how: 'saved' });
    if (doc.statementReview?.charge) saved.push({ doc, charge: doc.statementReview.charge, how: 'flagged' });
  }
  const byAmount = new Map();
  saved.forEach((s, index) => {
    const amount = Number(s.charge.amount);
    if (!Number.isFinite(amount) || !s.charge.date) return;
    const key = Math.round(Math.abs(amount) * 100);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push({ ...s, index, amount, words: words(String(s.charge.description || '').replace(/\d+/g, ' ')) });
  });
  const taken = new Set();
  const found = new Map();
  const sameDay = (t, s) => s.charge.date === t.date || s.charge.date === t.postedDate;
  const sameText = (t, s, w) => shareWord(w, s.words) || plain(t.description) === plain(s.charge.description);
  const passes = [
    (t, s, w) => sameDay(t, s) && sameText(t, s, w),
    (t, s, w) => dayGap(s.charge.date, t.date) <= 3 && sameText(t, s, w),
    (t, s) => sameDay(t, s) && label(s.charge.account) === label(t.account),
  ];
  for (const fits of passes) {
    for (const t of transactions) {
      if (found.has(t) || !t.date) continue;
      const w = words(String(t.description || '').replace(/\d+/g, ' '));
      // The same sign wins, so a charge and its refund don't swap fields;
      // then the nearest date, so a line posted two days later doesn't take
      // the field of the same purchase made that day.
      const flipped = (s) => (Math.sign(s.amount) !== Math.sign(t.amount) ? 1 : 0);
      const hit = (byAmount.get(Math.round(Math.abs(t.amount) * 100)) || [])
        .filter((s) => !taken.has(s.index) && fits(t, s, w))
        .sort((a, b) => flipped(a) - flipped(b) || dayGap(a.charge.date, t.date) - dayGap(b.charge.date, t.date))[0];
      if (!hit) continue;
      taken.add(hit.index);
      found.set(t, { doc: hit.doc, how: hit.how, signFlipped: Math.sign(hit.amount) !== Math.sign(t.amount) });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Matching charges to receipts.
// ---------------------------------------------------------------------------
const usableReceipt = (r) => r && r.date && typeof r.total === 'number' && Math.abs(r.total) >= 0.005;

// The receipt's amount is the charge's: CAD, or the foreign amount for a
// receipt in another currency.
function amountFits(r, t) {
  const want = Math.abs(r.total);
  if ((r.currency || 'CAD') === 'CAD') return close(Math.abs(t.amount), want);
  return t.foreignAmount != null && (!t.foreignCurrency || t.foreignCurrency === r.currency)
    && close(Math.abs(t.foreignAmount), want);
}
const sameSign = (r, t) => (r.total < 0) === (t.amount < 0);

// `transactions` should already leave out charges in Slip. Transfers and
// income never match. Receipts with a saved `statement` field are taken
// already and should be left out of `receipts`; `guardReceipts` (default
// `receipts`) are every real receipt, for the duplicate guard.
// Returns { matches: [{ receipt, transaction, how }], unclear: [{ receipt,
// transaction, reason }] }.
function matchToReceipts(transactions, receipts, { rules = [], guardReceipts = receipts } = {}) {
  const charges = transactions
    .map((t) => ({ t, bucket: t.bucket || classify(t, rules), words: words(lineText(t)) }))
    .filter((c) => c.t.date && !['transfer', 'income'].includes(c.bucket));
  const byDay = new Map();
  for (const c of charges) {
    const d = day(c.t.date);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(c);
  }
  const near = (date, maxDays) => {
    const d = day(date);
    const list = [];
    for (let k = -maxDays; k <= maxDays; k++) list.push(...(byDay.get(d + k) || []));
    return list;
  };

  const list = receipts.filter(usableReceipt)
    .map((r) => ({ r, words: receiptWords(r.merchant) }))
    .sort((a, b) => a.r.date.localeCompare(b.r.date) || String(a.r.id).localeCompare(String(b.r.id)));
  const used = new Set();
  const matched = new Map();
  const matches = [];
  const unclear = [];
  const take = (entry, c, how) => {
    used.add(c);
    matched.set(entry.r, c);
    matches.push({ receipt: entry.r, transaction: c.t, how });
  };

  // Exact amount and a shared store word, nearest day first.
  for (const maxDays of [0, 1, 2, 4, 7]) {
    for (const entry of list) {
      if (matched.has(entry.r)) continue;
      const fits = near(entry.r.date, maxDays).filter((c) => !used.has(c) && sameSign(entry.r, c.t)
        && amountFits(entry.r, c.t) && shareWord(entry.words, c.words));
      if (!fits.length) continue;
      fits.sort((a, b) => dayGap(a.t.date, entry.r.date) - dayGap(b.t.date, entry.r.date));
      take(entry, fits[0], 'store');
    }
  }
  // Amount alone: within a day, when only one charge fits.
  for (const entry of list) {
    if (matched.has(entry.r)) continue;
    const fits = near(entry.r.date, 1).filter((c) => !used.has(c) && sameSign(entry.r, c.t) && amountFits(entry.r, c.t));
    if (fits.length === 1) take(entry, fits[0], 'amount');
  }
  // Unclear: the same amount under another name, or the same store with an
  // amount within 30%.
  for (const entry of list) {
    if (matched.has(entry.r)) continue;
    const r = entry.r;
    const sameAmount = near(r.date, 2).find((c) => !used.has(c) && sameSign(r, c.t) && amountFits(r, c.t));
    const sameStore = near(r.date, 3).find((c) => !used.has(c) && sameSign(r, c.t) && shareWord(entry.words, c.words)
      && Math.abs(Math.abs(c.t.amount) - Math.abs(r.total)) <= Math.max(1, 0.3 * Math.abs(r.total)));
    const c = sameAmount || sameStore;
    if (!c) continue;
    used.add(c);
    unclear.push({ receipt: r, transaction: c.t, reason: sameAmount ? REASONS.otherName : REASONS.otherAmount });
  }
  // Duplicate guard: a new charge with the same amount as any receipt within
  // 7 days is unclear, not new.
  const guards = guardReceipts.filter(usableReceipt);
  for (const c of charges) {
    if (used.has(c) || c.bucket !== 'spend') continue;
    const r = guards.find((g) => close(Math.abs(g.total), Math.abs(c.t.amount)) && dayGap(c.t.date, g.date) <= 7);
    if (!r) continue;
    used.add(c);
    unclear.push({ receipt: r, transaction: c.t, reason: REASONS.guard });
  }
  return { matches, unclear };
}

// ---------------------------------------------------------------------------
// Names and categories.
// ---------------------------------------------------------------------------
const PLACE = /\s+(TORONTO|TORONT|ON|ONTARIO|CANADA|SCARBOROUGH|NORTH YORK|MISSISSAUGA|ETOBICOKE|MONTREAL|VANCOUVER|NEW YORK|SAN FRANCISCO|STOCKHOLM|LONDON|HAMILTON|WASHINGTON|Retail and Grocery|Restaurants|Hotel, Entertainment and Recreation|Professional and Financial Services|Transportation|Personal and Household Expenses|Health and Education|Foreign Currency Transactions|Other Transactions)$/i;

// "MCDONALD'S #40764 TORONTO" -> "McDonald's"; "KRISPY KREME #553" -> "Krispy Kreme".
function cleanName(raw) {
  let s = String(raw || '').replace(/https?:\/\/\S*/ig, ' ').replace(/\/\S*\d\S*/g, ' ').replace(/\S*\d[\d-]{4,}\S*/g, ' ')
    .replace(/\.com\b/ig, '').replace(/\s+/g, ' ').trim();
  for (let k = 0; k < 4; k++) s = s.replace(PLACE, '').trim();
  s = s.replace(/\s*#\s*\d+.*$/, '').replace(/\s+\d{3,}$/, '').replace(/[*]/g, ' ').replace(/\s+/g, ' ').trim();
  const known = normalizeMerchant(s);
  if (known !== s) return known;
  s = s.replace(/^(Mcdonald|MCDONALD)['’]?S\b.*/i, "McDonald's");
  if (s === "McDonald's") return s;
  return /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/'S\b/g, "'s");
}

// [category, subCategory] from a statement name.
function guess(name) {
  const v = String(name || '').toLowerCase();
  if (/loblaw|metro|sobeys|freshco|no ?frills|costco|grocery|food basics|farm boy|whole foods|trader joe|longo|t&t|rcss|superstore/.test(v)) return ['Grocery', 'Supermarket'];
  if (/shoppers|sdm|rexall|pharma|drug/.test(v)) return ['Health', 'Pharmacy'];
  if (/tim hortons|starbucks|second cup|coffee|cafe|dunkin/.test(v)) return ['Takeout/Dining', 'Coffee Shop'];
  if (/restaurant|mcdonald|uber eats|doordash|skip|pizza|burger|subway|wendy|taco|popeyes|a&w|kfc|sushi|ramen|grill|bar\b|pub/.test(v)) return ['Takeout/Dining', 'Restaurant'];
  if (/ttc|transit|uber|lyft|parking|presto|go transit|bike share|via rail|metrolinx/.test(v)) return ['Transport', 'Transit'];
  if (/air canada|porter|westjet|hotel|airbnb|expedia|flair|united|amtrak|marriott/.test(v)) return ['Transport', 'Travel'];
  if (/netflix|spotify|disney|cineplex|ticketmaster|steam/.test(v)) return ['Entertainment', null];
  if (/amazon|amzn|walmart|wal-mart|uniqlo|ikea|winners|old ?navy|h&m|gap|simons|dollarama|canadian tire|best buy/.test(v)) return ['Shopping', null];
  if (/hydro|enbridge/.test(v)) return ['Home', 'Utilities'];
  if (/koodo|rogers|bell|telus|fido|freedom mobile|oxio/.test(v)) return ['Home', 'Phone and internet'];
  if (/manulife|health insurance/.test(v)) return ['Health', 'Insurance'];
  if (/insurance|zipsure/.test(v)) return ['Other', 'Insurance'];
  if (/nslsc/.test(v)) return ['Other', 'Student loan'];
  if (/ymca|goodlife|fitness/.test(v)) return ['Health', 'Fitness'];
  if (/walgreens|cvs/.test(v)) return ['Health', 'Pharmacy'];
  if (/circle k|7.?eleven|macs conv|couche.?tard/.test(v)) return ['Grocery', 'Convenience store'];
  if (/lcbo|wine rack|beer store|saq/.test(v)) return ['Grocery', 'Alcohol'];
  if (/target|thebay|hudson|winners|marshalls/.test(v)) return ['Shopping', null];
  if (/new york times|nytimes|patreon|youtube|google play/.test(v)) return ['Entertainment', 'Subscription'];
  if (/nfta|orca|grt|smovengo|lim ride|stm |metro bike|bixi|velib|communauto|clipper/.test(v)) return ['Transport', 'Transit'];
  if (/nsf|overdraft/.test(v)) return ['Other', 'Bank fee'];
  return ['Other', null];
}

const RECURRING = /apple\.com\/bill|spotify|netflix|claude|openai|koodo|hydro|insurance|goodlife|membership fee|manulife|nslsc|ymca/i;
const stripNumbers = (text) => String(text || '').replace(/\S*\d[\d-]{4,}\S*/g, '').replace(/\s+/g, ' ').trim();

// Names for Transfer lines.
function transferName(text) {
  const m = String(text || '').toUpperCase();
  if (/PAYMENT RECEIVED|PAYMENT - THANK|PAYMENT THANK/.test(m)) return 'Card payment received';
  if (/AMERICAN EXPRESS|AMEX/.test(m)) return 'Payment to Amex';
  if (/VISA SIMPLII|SIMPLII.*VISA/.test(m)) return 'Payment to Simplii Visa';
  if (/MBNA/.test(m)) return 'Payment to MBNA Mastercard';
  if (/VISA, TD|TD\/BANQUE/.test(m)) return 'Payment to TD Visa';
  if (/CIBC/.test(m)) return 'Payment to CIBC';
  if (/CANADIAN TIRE|CDN TIRE|TRIANGLE/.test(m)) return 'Payment to Canadian Tire Mastercard';
  if (/WALMART|WAL-MART/.test(m)) return 'Payment to Walmart Mastercard';
  if (/CRA REVENUE/.test(m)) return 'CRA tax instalment';
  if (/ABM WITHDRAWAL|ATM/.test(m)) return 'Cash withdrawal';
  if (/WEALTHSIMPLE/.test(m)) return 'Wealthsimple';
  if (/E-TRANSFER/.test(m)) return /SEND/.test(m) ? 'E-transfer sent' : 'E-transfer received';
  if (/TRANSFER/.test(m)) return 'Transfer between accounts';
  if (/RETURNED PAYMENT/.test(m)) return 'Returned card payment';
  return stripNumbers(text).slice(0, 80) || 'Transfer';
}

// A statement name that only ever matched receipts from one store, which it
// doesn't name (Amex shows some McDonald's as just their street), takes that
// store's name. `pairs` is [{ description, merchant }] from matched receipts.
const nameKey = (text) => cleanName(text).toLowerCase();
function learnNames(pairs) {
  const seen = new Map();
  for (const { description, merchant } of pairs) {
    if (!description || !merchant) continue;
    const key = nameKey(description);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(merchant);
  }
  const learned = new Map();
  for (const [key, names] of seen) {
    const first = names[0].toUpperCase().split(/[^A-Z]/)[0];
    if (names.length >= 2 && new Set(names).size === 1 && first && !key.toUpperCase().includes(first)) learned.set(key, names[0]);
  }
  return learned;
}

// ---------------------------------------------------------------------------
// Keys. The backfill's scheme: label|date|amount|name|n, with "xfer|" in front
// for Transfer and Income, where n counts the same line earlier in the run.
// `transactions` must be in a fixed order (lib/statement-files sorts them).
// ---------------------------------------------------------------------------
function assignKeys(transactions, rules = []) {
  const seen = new Map();
  const keys = new Map();
  for (const t of transactions) {
    const bucket = t.bucket || classify(t, rules);
    const parts = [label(t.account), t.date, cents(t.amount).toFixed(2), lineText(t)];
    if (['transfer', 'income'].includes(bucket)) parts.unshift('xfer');
    const base = parts.join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    keys.set(t, `stmt:${sha(`${base}|${n}`).slice(0, 40)}`);
  }
  return keys;
}

// The statement field saved on entries and matched receipts.
function statementField(t) {
  return { account: label(t.account), date: t.date, amount: cents(t.amount), description: String(t.description || lineText(t)).slice(0, 120) };
}

// One importReceipt payload for a charge.
function entryFor(t, bucket, { rule, learned, key }) {
  const amount = cents(t.amount);
  const text = lineText(t);
  let merchant;
  let category;
  let subCategory = null;
  let isSubscription = RECURRING.test(t.description || text);
  if (bucket === 'transfer' || bucket === 'income') {
    category = bucket === 'income' ? 'Income' : 'Transfer';
    merchant = bucket === 'income' ? (stripNumbers(text).slice(0, 80) || 'Income') : transferName(t.description || text);
    isSubscription = false;
  } else {
    const known = learned.get(nameKey(text));
    merchant = known || cleanName(text);
    [category, subCategory] = guess(known || text);
    if (bucket === 'rent') {
      merchant = 'Rent';
      [category, subCategory] = ['Home', 'Rent'];
      isSubscription = true;
    }
    if (bucket === 'cardFees') [category, subCategory] = ['Other', /interest|regular purchases/i.test(text) ? 'Interest' : 'Card fee'];
    if (/^REGULAR PURCHASES \d/i.test(text)) merchant = 'Interest';
  }
  if (rule) {
    if (rule.merchant) merchant = rule.merchant;
    if (rule.category) [category, subCategory] = [rule.category, rule.subCategory || null];
    else if (rule.subCategory) subCategory = rule.subCategory;
  }
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    merchant: String(merchant || 'Unknown').slice(0, 100),
    currency: 'CAD',
    total: Math.abs(amount),
    date: t.date,
    type: amount < 0 ? 'refund' : 'purchase',
    category,
    ...(subCategory ? { subCategory } : {}),
    isSubscription,
    source: { client: 'statement' },
  };
}

// Entries to add for charges with no receipt, and Transfer and Income lines.
// Never adds a charge already in Slip (a saved statement field or a used
// key), and never one that matched or may match a receipt, whatever its
// bucket. Pass every transaction read, in order, so keys and the one-to-one
// statement check are the same each run. Options:
//   docs          every Slip doc for the account (for statement fields)
//   matches       [{ receipt, transaction }] from matchToReceipts
//   unclear       [{ receipt, transaction }] from matchToReceipts
//   rules         saved rules
//   existingKeys  idempotency keys already used
//   keys          Map from assignKeys (made here when not given)
// Returns { entries: [{ transaction, bucket, args, statement }], skipped,
// invalid: [{ transaction, errors }] }.
function planEntries(transactions, { docs = [], matches = [], unclear = [], rules = [], existingKeys = new Set(), keys } = {}) {
  const inSlip = alreadyInSlip(transactions, docs);
  const taken = new Set([...matches, ...unclear].map((m) => m.transaction));
  const keyOf = keys || assignKeys(transactions, rules);
  const learned = learnNames([
    ...docs.filter((d) => d.statement && d.importSource?.tokenId !== 'statement-upload')
      .map((d) => ({ description: d.statement.description, merchant: d.merchant })),
    ...matches.map((m) => ({ description: lineText(m.transaction), merchant: m.receipt.merchant })),
  ]);
  const skipped = { alreadyInSlip: 0, matched: 0, unknown: 0, keyUsed: 0, zero: 0 };
  const entries = [];
  const invalid = [];
  for (const t of transactions) {
    const bucket = t.bucket || classify(t, rules);
    if (inSlip.has(t)) { skipped.alreadyInSlip++; continue; }
    if (taken.has(t)) { skipped.matched++; continue; }
    if (!ADDED_BUCKETS.includes(bucket)) { skipped.unknown++; continue; }
    if (!t.date || Math.abs(cents(t.amount)) < 0.005) { skipped.zero++; continue; }
    const key = keyOf.get(t);
    if (existingKeys.has(key)) { skipped.keyUsed++; continue; }
    const args = entryFor(t, bucket, { rule: findRule(t, rules), learned, key });
    const { errors } = validateImport(args);
    if (errors.length) { invalid.push({ transaction: t, errors }); continue; }
    entries.push({ transaction: t, bucket, args, statement: statementField(t) });
  }
  return { entries, skipped, invalid };
}

module.exports = {
  BUCKETS,
  REASONS,
  label,
  ruleProblems,
  findRule,
  classify,
  words,
  receiptWords,
  shareWord,
  alreadyInSlip,
  matchToReceipts,
  cleanName,
  guess,
  learnNames,
  assignKeys,
  statementField,
  planEntries,
};

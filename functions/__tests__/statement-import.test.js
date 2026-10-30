const {
  REASONS, ruleProblems, findRule, classify, alreadyInSlip, matchToReceipts, cleanName, learnNames, assignKeys, planEntries,
} = require('../lib/statement-import');

// Made-up statement lines and receipts only.
let n = 0;
const tx = (fields) => ({
  account: 'Test Card', date: '2025-03-10', postedDate: null, description: 'PRETEND STORE TORONTO', merchant: null,
  location: '', amount: 10, currency: 'CAD', foreignAmount: null, foreignCurrency: null, kind: 'purchase', ...fields,
});
const receipt = (fields) => ({ id: `r${++n}`, merchant: 'Pretend Store', date: '2025-03-10', total: 10, currency: 'CAD', ...fields });

const RENT_RULES = [
  { pattern: 'MEDALLION', merchant: 'Rent', category: 'Home', subCategory: 'Rent', bucket: 'rent' },
  { pattern: 'INTERAC E-TRANSFER SEND', minAmount: 945, maxAmount: 945, bucket: 'rent' },
  { pattern: 'METRO 62', minAmount: 1000, merchant: 'Metro Pharmacy', category: 'Health', subCategory: 'Pharmacy' },
];

describe('rules', () => {
  test('a good rule has no problems', () => {
    RENT_RULES.forEach((rule) => expect(ruleProblems(rule)).toEqual([]));
  });

  test('bad rules are explained', () => {
    expect(ruleProblems({})).toContain('pattern is required');
    expect(ruleProblems({ pattern: '(' })).toContain('pattern is not a valid regex');
    expect(ruleProblems({ pattern: 'X', bucket: 'food' })[0]).toMatch(/bucket must be one of/);
    expect(ruleProblems({ pattern: 'X', category: 'Snacks' })[0]).toMatch(/category must be one of/);
    expect(ruleProblems({ pattern: 'X', minAmount: '5' })).toContain('minAmount must be a number');
    expect(ruleProblems({ pattern: 'X', note: 'hi' })).toContain('unknown field note');
  });

  test('patterns ignore case and amounts compare either way', () => {
    expect(findRule(tx({ description: 'metro 62 toronto', amount: 1200 }), RENT_RULES)).toBe(RENT_RULES[2]);
    expect(findRule(tx({ description: 'METRO 62 TORONTO', amount: -1200 }), RENT_RULES)).toBe(RENT_RULES[2]);
    expect(findRule(tx({ description: 'METRO 62 TORONTO', amount: 40 }), RENT_RULES)).toBeNull();
  });

  test('a bad rule never fits', () => {
    expect(findRule(tx({ description: 'ANYTHING' }), [{ pattern: '(' }, { pattern: 'ANY', bucket: 'nope' }])).toBeNull();
  });
});

describe('classify', () => {
  test('kinds become buckets', () => {
    expect(classify(tx({ kind: 'purchase' }))).toBe('spend');
    expect(classify(tx({ kind: 'refund', amount: -5 }))).toBe('spend');
    expect(classify(tx({ kind: 'bill' }))).toBe('bills');
    expect(classify(tx({ kind: 'fee' }))).toBe('cardFees');
    expect(classify(tx({ kind: 'interest' }))).toBe('cardFees');
    expect(classify(tx({ kind: 'reload' }))).toBe('reload');
    expect(classify(tx({ kind: 'rent' }))).toBe('rent');
    expect(classify(tx({ kind: 'card-payment' }))).toBe('transfer');
    expect(classify(tx({ kind: 'cash' }))).toBe('transfer');
    expect(classify(tx({ kind: 'etransfer-person' }))).toBe('transfer');
    expect(classify(tx({ kind: 'income', amount: -500 }))).toBe('income');
    expect(classify(tx({ kind: 'unknown' }))).toBe('unknown');
  });

  test('saved rules go first', () => {
    const send = tx({ description: 'INTERAC E-TRANSFER SEND PRETEND PERSON', kind: 'etransfer-person', amount: 945 });
    expect(classify(send, RENT_RULES)).toBe('rent');
    expect(classify({ ...send, amount: 900 }, RENT_RULES)).toBe('transfer');
    expect(classify(tx({ description: 'MEDALLION-PRETEND', kind: 'unknown', amount: 50 }), RENT_RULES)).toBe('rent');
  });

  test('a rule without a bucket keeps the kind', () => {
    expect(classify(tx({ description: 'METRO 62 TORONTO', amount: 1200 }), RENT_RULES)).toBe('spend');
  });

  test('returned payments and tax instalments are transfers', () => {
    expect(classify(tx({ description: 'PRETEND CARD RETURNED PAYMENT', kind: 'unknown' }))).toBe('transfer');
    expect(classify(tx({ description: 'CRA REVENUE - TAX INSTA', kind: 'bill' }))).toBe('transfer');
  });
});

describe('matchToReceipts', () => {
  test('exact amount and a shared store word, same day first', () => {
    const near = tx({ description: 'PRETEND STORE #12 TORONTO', date: '2025-03-10' });
    const later = tx({ description: 'PRETEND STORE #12 TORONTO', date: '2025-03-12' });
    const { matches, unclear } = matchToReceipts([later, near], [receipt({})]);
    expect(matches).toHaveLength(1);
    expect(matches[0].transaction).toBe(near);
    expect(matches[0].how).toBe('store');
    // The later one has the receipt's amount, so the guard holds it back.
    expect(unclear.map((u) => u.transaction)).toEqual([later]);
  });

  test('a store word match reaches 7 days', () => {
    const charge = tx({ description: 'PRETEND STORE', date: '2025-03-17' });
    expect(matchToReceipts([charge], [receipt({})]).matches[0].transaction).toBe(charge);
  });

  test('a place name is not a store word', () => {
    const charge = tx({ description: 'OTHER SHOP TORONTO', amount: 10, date: '2025-03-14' });
    const { matches, unclear } = matchToReceipts([charge], [receipt({ merchant: 'Toronto Fake Museum' })]);
    expect(matches).toEqual([]);
    // Still the same amount near a receipt, so it is not added blindly.
    expect(unclear[0].reason).toBe(REASONS.guard);
  });

  test("a McDonald's shown only by its street matches on amount alone", () => {
    const street = tx({ description: 'PRETEND STREET EAST TORONTO', amount: 1.05 });
    const { matches } = matchToReceipts([street], [receipt({ merchant: "McDonald's", total: 1.05 })]);
    expect(matches).toHaveLength(1);
    expect(matches[0].how).toBe('amount');
  });

  test('two street-only charges that both fit are unclear, not matched', () => {
    const a = tx({ description: 'PRETEND STREET EAST TORONTO', amount: 1.05 });
    const b = tx({ description: 'PRETEND AND OTHER TORONTO', amount: 1.05, date: '2025-03-11' });
    const { matches, unclear } = matchToReceipts([a, b], [receipt({ merchant: "McDonald's", total: 1.05 })]);
    expect(matches).toEqual([]);
    expect(unclear[0].reason).toBe(REASONS.otherName);
  });

  test("McDonald's spelled the statement's way shares a word", () => {
    const charge = tx({ description: "MCDONALD'S #99999 TORONTO", amount: 7.5, date: '2025-03-11' });
    const other = tx({ description: 'PRETEND STREET', amount: 7.5, date: '2025-03-10' });
    const { matches } = matchToReceipts([other, charge], [receipt({ merchant: "McDonald's", total: 7.5 })]);
    expect(matches[0].transaction).toBe(charge);
  });

  test('a USD receipt matches the foreign amount', () => {
    const charge = tx({ description: 'AMZN MKTP US', amount: 27.4, foreignAmount: 20, foreignCurrency: 'USD' });
    const { matches } = matchToReceipts([charge], [receipt({ merchant: 'Amazon', total: 20, currency: 'USD' })]);
    expect(matches[0].transaction).toBe(charge);
  });

  test('a USD receipt does not match the CAD amount', () => {
    const charge = tx({ description: 'AMZN MKTP US', amount: 20, foreignAmount: 14.6, foreignCurrency: 'USD' });
    const { matches } = matchToReceipts([charge], [receipt({ merchant: 'Amazon', total: 20, currency: 'USD' })]);
    expect(matches).toEqual([]);
  });

  test('the same store with an amount within 30% is unclear', () => {
    const charge = tx({ description: 'PRETEND BURRITO ONLINE', amount: 22.43 });
    const { matches, unclear } = matchToReceipts([charge], [receipt({ merchant: 'Pretend Burrito', total: 19.85 })]);
    expect(matches).toEqual([]);
    expect(unclear).toEqual([{ receipt: expect.objectContaining({ merchant: 'Pretend Burrito' }), transaction: charge, reason: REASONS.otherAmount }]);
  });

  test('guard: a second charge with the amount of a matched receipt is unclear', () => {
    const first = tx({ description: 'PRETEND STORE', date: '2025-03-10' });
    const second = tx({ description: 'PRETEND STORE', date: '2025-03-15' });
    const r = receipt({});
    const { matches, unclear } = matchToReceipts([first, second], [r]);
    expect(matches[0].transaction).toBe(first);
    expect(unclear).toEqual([{ receipt: r, transaction: second, reason: REASONS.guard }]);
  });

  test('guard uses every real receipt, also ones already linked', () => {
    const charge = tx({ description: 'SOMETHING ELSE', date: '2025-03-14' });
    const linked = receipt({ merchant: 'Linked Shop', statement: { date: '2025-03-10' } });
    const { unclear } = matchToReceipts([charge], [], { guardReceipts: [linked] });
    expect(unclear[0].receipt).toBe(linked);
  });

  test('the guard leaves bills, fees and transfers alone', () => {
    const bill = tx({ description: 'PRETEND MOBILE', kind: 'bill', date: '2025-03-14' });
    const payment = tx({ description: 'PAYMENT RECEIVED', kind: 'card-payment', amount: -10 });
    const { unclear } = matchToReceipts([bill, payment], [], { guardReceipts: [receipt({ merchant: 'Elsewhere' })] });
    expect(unclear).toEqual([]);
  });

  test('transfers never match a receipt', () => {
    const payment = tx({ description: 'PRETEND STORE PAYMENT', kind: 'card-payment' });
    expect(matchToReceipts([payment], [receipt({})]).matches).toEqual([]);
  });
});

describe('alreadyInSlip', () => {
  const saved = (statement, fields = {}) => receipt({ statement, importSource: { tokenId: 'statement-upload' }, ...fields });

  test('matches a saved field under another account label', () => {
    const t = tx({ account: 'Pretend Chequing', description: 'PRETEND GYM INC', amount: 50 });
    const doc = saved({ account: 'Pretend Chequing Account', date: '2025-03-10', amount: 50, description: 'PRETEND GYM INC' });
    expect(alreadyInSlip([t], [doc]).get(t)).toEqual({ doc, how: 'saved', signFlipped: false });
  });

  test('allows a posted date up to 3 days later and a flipped sign', () => {
    const t = tx({ description: 'PRETEND MOBILE', amount: 67.8, date: '2025-03-13' });
    const doc = saved({ account: 'X', date: '2025-03-16', amount: -67.8, description: 'Pretend Mobile' });
    expect(alreadyInSlip([t], [doc]).get(t).signFlipped).toBe(true);
  });

  test('a description made only of place words matches when equal', () => {
    const t = tx({ description: 'CANADA', amount: -115.78, kind: 'income' });
    const doc = saved({ account: 'Other Label', date: '2025-03-10', amount: -115.78, description: 'CANADA' });
    expect(alreadyInSlip([t], [doc]).has(t)).toBe(true);
  });

  test('each saved field takes one charge, nearest date first', () => {
    const early = tx({ description: 'PRETEND STORE 1', amount: 1.05, date: '2025-03-08', postedDate: '2025-03-10' });
    const exact = tx({ description: 'PRETEND STORE 2', amount: 1.05, date: '2025-03-10' });
    const docs = [
      saved({ account: 'Test Card', date: '2025-03-10', amount: 1.05, description: 'PRETEND STORE' }),
      saved({ account: 'Test Card', date: '2025-03-08', amount: 1.05, description: 'PRETEND STORE' }),
    ];
    const found = alreadyInSlip([early, exact], docs);
    expect(found.get(early).doc).toBe(docs[1]);
    expect(found.get(exact).doc).toBe(docs[0]);
  });

  test('a street-only charge matches a renamed line on the same day and account', () => {
    const t = tx({ description: 'PRETEND AND DUNDAS TORONTO', amount: 1.05 });
    const doc = saved({ account: 'Test Card', date: '2025-03-10', amount: 1.05, description: "MCDONALD'S" });
    expect(alreadyInSlip([t], [doc]).has(t)).toBe(true);
  });

  test('a charge and its refund keep their own fields', () => {
    const charge = tx({ description: 'PRETEND HOTEL', amount: 74, date: '2025-03-10' });
    const refund = tx({ description: 'PRETEND HOTEL', amount: -74, date: '2025-03-10', kind: 'refund' });
    const docs = [
      saved({ account: 'Test Card', date: '2025-03-10', amount: 74, description: 'PRETEND HOTEL' }),
      saved({ account: 'Test Card', date: '2025-03-10', amount: -74, description: 'PRETEND HOTEL' }),
    ];
    const found = alreadyInSlip([refund, charge], docs);
    expect(found.get(charge)).toEqual({ doc: docs[0], how: 'saved', signFlipped: false });
    expect(found.get(refund)).toEqual({ doc: docs[1], how: 'saved', signFlipped: false });
  });

  test('a charge named on a review mark counts as flagged', () => {
    const t = tx({ description: 'PRETEND BURRITO ONLINE', amount: 22.43 });
    const doc = receipt({ statementReview: { reason: REASONS.otherAmount, charge: { account: 'Test Card', date: '2025-03-10', amount: 22.43, description: 'PRETEND BURRITO ONLINE' } } });
    expect(alreadyInSlip([t], [doc]).get(t).how).toBe('flagged');
  });

  test('a different amount is not the same charge', () => {
    const t = tx({ amount: 10.01 });
    expect(alreadyInSlip([t], [saved({ account: 'Test Card', date: '2025-03-10', amount: 10, description: 'PRETEND STORE' })]).size).toBe(0);
  });
});

describe('names', () => {
  test('cleanName drops places, store numbers and long numbers', () => {
    expect(cleanName('PRETEND KREME #553 TORONTO')).toBe('Pretend Kreme');
    expect(cleanName("MCDONALD'S 99999 TORONTO")).toBe("McDonald's");
    expect(cleanName('PRETEND SHOP 1234567 ON')).toBe('Pretend Shop');
  });

  test('a street name that only matched one store learns its name', () => {
    const learned = learnNames([
      { description: 'PRETEND STREET EAST TORONTO', merchant: "McDonald's" },
      { description: 'PRETEND STREET EAST', merchant: "McDonald's" },
      { description: 'ONE TIME ONLY', merchant: 'Somewhere' },
      { description: 'MIXED PLACE', merchant: 'A Shop' },
      { description: 'MIXED PLACE', merchant: 'B Shop' },
    ]);
    expect([...learned]).toEqual([['pretend street east', "McDonald's"]]);
  });
});

describe('keys', () => {
  test('stable across runs, different for two identical charges', () => {
    const run = () => [tx({ description: 'PRETEND COFFEE' }), tx({ description: 'PRETEND COFFEE' }), tx({ amount: 3 })];
    const first = run();
    const second = run();
    const a = assignKeys(first);
    const b = assignKeys(second);
    expect(first.map((t) => a.get(t))).toEqual(second.map((t) => b.get(t)));
    expect(new Set(first.map((t) => a.get(t))).size).toBe(3);
    expect(a.get(first[0])).toMatch(/^stmt:[0-9a-f]{40}$/);
  });

  test("the backfill's scheme: label without digits, transfers prefixed", () => {
    const crypto = require('crypto');
    const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
    const spend = tx({ account: 'Pretend Card 12345', merchant: 'PRETEND COFFEE' });
    const pay = tx({ account: 'Pretend Card', description: 'PAYMENT RECEIVED', amount: -50, kind: 'card-payment' });
    const keys = assignKeys([spend, pay]);
    expect(keys.get(spend)).toBe(`stmt:${sha('Pretend Card|2025-03-10|10.00|PRETEND COFFEE|1').slice(0, 40)}`);
    expect(keys.get(pay)).toBe(`stmt:${sha('xfer|Pretend Card|2025-03-10|-50.00|PAYMENT RECEIVED|1').slice(0, 40)}`);
  });
});

describe('planEntries', () => {
  const plan = (transactions, options = {}) => {
    transactions.forEach((t) => { t.bucket = classify(t, options.rules || []); });
    return planEntries(transactions, options);
  };

  test('builds entries for each bucket', () => {
    const spend = tx({ description: 'PRETEND PIZZA #4 TORONTO', amount: 12.5 });
    const refund = tx({ description: 'PRETEND PIZZA #4 TORONTO', amount: -12.5, kind: 'refund' });
    const rent = tx({ account: 'Pretend Chequing', description: 'MEDALLION-PRETEND', amount: 1500, kind: 'rent' });
    const fee = tx({ description: 'MEMBERSHIP FEE INSTALLMENT', amount: 12.99, kind: 'fee' });
    const interest = tx({ description: 'INTEREST', amount: 4, kind: 'interest' });
    const payment = tx({ description: 'PAYMENT RECEIVED - THANK YOU', amount: -100, kind: 'card-payment' });
    const pay = tx({ account: 'Pretend Chequing', description: 'PRETEND PAYROLL', amount: -2000, kind: 'income' });
    const unknown = tx({ account: 'Pretend Chequing', description: 'MYSTERY', kind: 'unknown' });
    const { entries, skipped } = plan([spend, refund, rent, fee, interest, payment, pay, unknown], { rules: RENT_RULES });
    const by = new Map(entries.map((e) => [e.transaction, e.args]));
    expect(by.get(spend)).toMatchObject({ merchant: 'Pretend Pizza', category: 'Takeout/Dining', subCategory: 'Restaurant', type: 'purchase', total: 12.5, currency: 'CAD', source: { client: 'statement' } });
    expect(by.get(refund)).toMatchObject({ type: 'refund', total: 12.5 });
    expect(by.get(rent)).toMatchObject({ merchant: 'Rent', category: 'Home', subCategory: 'Rent', isSubscription: true });
    expect(by.get(fee)).toMatchObject({ category: 'Other', subCategory: 'Card fee' });
    expect(by.get(interest)).toMatchObject({ category: 'Other', subCategory: 'Interest' });
    expect(by.get(payment)).toMatchObject({ merchant: 'Card payment received', category: 'Transfer', type: 'refund' });
    expect(by.get(pay)).toMatchObject({ merchant: 'PRETEND PAYROLL', category: 'Income', type: 'refund' });
    expect(by.has(unknown)).toBe(false);
    expect(skipped.unknown).toBe(1);
    const statement = entries.find((e) => e.transaction === rent).statement;
    expect(statement).toEqual({ account: 'Pretend Chequing', date: '2025-03-10', amount: 1500, description: 'MEDALLION-PRETEND' });
  });

  test('an e-transfer for the rent amount is rent; a rule sets the name and category', () => {
    const send = tx({ description: 'INTERAC E-TRANSFER SEND PRETEND PERSON', amount: 945, kind: 'etransfer-person' });
    const pharmacy = tx({ description: 'METRO 62 TORONTO', amount: 1200 });
    const { entries } = plan([send, pharmacy], { rules: RENT_RULES });
    expect(entries[0].args).toMatchObject({ merchant: 'Rent', category: 'Home', subCategory: 'Rent' });
    expect(entries[1].args).toMatchObject({ merchant: 'Metro Pharmacy', category: 'Health', subCategory: 'Pharmacy' });
  });

  test('never adds a charge already in Slip, under any label', () => {
    const t = tx({ account: 'Pretend Chequing', description: 'PRETEND MOBILE', amount: 67.8, kind: 'bill', date: '2025-03-13' });
    const doc = receipt({ statement: { account: 'Pretend Chequing Account', date: '2025-03-14', amount: 67.8, description: 'Pretend Mobile' } });
    const { entries, skipped } = plan([t], { docs: [doc] });
    expect(entries).toEqual([]);
    expect(skipped.alreadyInSlip).toBe(1);
  });

  test('two identical coffees with one in Slip add only the other', () => {
    const a = tx({ description: 'PRETEND COFFEE', amount: 4.5 });
    const b = tx({ description: 'PRETEND COFFEE', amount: 4.5 });
    const doc = receipt({ statement: { account: 'Test Card', date: '2025-03-10', amount: 4.5, description: 'PRETEND COFFEE' } });
    const { entries } = plan([a, b], { docs: [doc] });
    expect(entries.map((e) => e.transaction)).toEqual([b]);
  });

  test('never adds a used key', () => {
    const t = tx({});
    const keys = assignKeys([t]);
    const { entries, skipped } = plan([t], { existingKeys: new Set([keys.get(t)]), keys });
    expect(entries).toEqual([]);
    expect(skipped.keyUsed).toBe(1);
  });

  test('a bill, rent or fee that matched a receipt is not added', () => {
    const bill = tx({ description: 'PRETEND MOBILE', amount: 67.8, kind: 'bill' });
    const rent = tx({ description: 'MEDALLION-PRETEND', amount: 1500, kind: 'rent' });
    const fee = tx({ description: 'MEMBERSHIP FEE', amount: 12.99, kind: 'fee' });
    const receipts = [
      receipt({ merchant: 'Pretend Mobile', total: 67.8 }),
      receipt({ merchant: 'Medallion Pretend', total: 1500 }),
      receipt({ merchant: 'Pretend Card Membership Fee', total: 12.99 }),
    ];
    const all = [bill, rent, fee];
    all.forEach((t) => { t.bucket = classify(t); });
    const { matches, unclear } = matchToReceipts(all, receipts);
    expect(matches).toHaveLength(3);
    const { entries, skipped } = planEntries(all, { matches, unclear });
    expect(entries).toEqual([]);
    expect(skipped.matched).toBe(3);
  });

  test('an unclear charge is not added', () => {
    const t = tx({ description: 'PRETEND BURRITO ONLINE', amount: 22.43 });
    const { matches, unclear } = matchToReceipts([t], [receipt({ merchant: 'Pretend Burrito', total: 19.85 })]);
    expect(plan([t], { matches, unclear }).entries).toEqual([]);
  });

  test('a street name learned from matched receipts names the entry', () => {
    const docs = [1, 2].map((i) => receipt({ merchant: "McDonald's", total: 1.05, date: `2025-02-0${i}`, statement: { account: 'Test Card', date: `2025-02-0${i}`, amount: 1.05, description: 'PRETEND STREET EAST TORONTO' } }));
    const t = tx({ description: 'PRETEND STREET EAST TORONTO', amount: 2.1 });
    const { entries } = plan([t], { docs });
    expect(entries[0].args).toMatchObject({ merchant: "McDonald's", category: 'Takeout/Dining', subCategory: 'Restaurant' });
  });

  test('the same input plans the same keys twice', () => {
    const make = () => [tx({ description: 'PRETEND COFFEE' }), tx({ description: 'PRETEND COFFEE' })];
    const keysOf = (list) => plan(list).entries.map((e) => e.args.idempotencyKey);
    expect(keysOf(make())).toEqual(keysOf(make()));
  });
});

// Reads bank and card statements into plain transactions (CIV-1186). Only
// reading and cleaning live here: matching against receipts and saving are
// done elsewhere. Statements are personal financial data, so nothing here
// keeps account or card numbers: accounts are named by label only.

const { parse: parseCsvText } = require('csv-parse/sync');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CURRENCIES = {
  'UNITED STATES DOLLAR': 'USD', 'EURO': 'EUR', 'BRITISH POUND': 'GBP', 'POUND STERLING': 'GBP',
  'MEXICAN PESO': 'MXN', 'JAPANESE YEN': 'JPY', 'AUSTRALIAN DOLLAR': 'AUD', 'SWISS FRANC': 'CHF',
};

const cents = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const monthIndex = (name) => MONTHS.indexOf(String(name).slice(0, 3).toLowerCase());
const close = (a, b) => Math.abs(a - b) < 0.005;
const sum = (list) => cents(list.reduce((total, n) => total + n, 0));

// "1,234.56", "-1,234.56", "$1,234.56", "-$1,234.56" or "1,234.56-" -> number.
function parseAmount(text) {
  const value = String(text).trim();
  const negative = value.startsWith('-') || value.endsWith('-');
  const number = Number(value.replace(/[-$,\s]/g, ''));
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

// "December 30, 2024" or "Dec 30, 2024" -> "2024-12-30".
function longDate(text) {
  const match = String(text).match(/([A-Za-z]+)\.? (\d{1,2}), (\d{4})/);
  if (!match || monthIndex(match[1]) < 0) return null;
  return `${match[3]}-${pad(monthIndex(match[1]) + 1)}-${pad(match[2])}`;
}

// A month and day printed without a year, placed in the statement that
// closes on `closing` (YYYY-MM-DD): a month after the closing month belongs
// to the year before, so December lines on a January statement land in the
// right year.
function dateInStatement(monthName, day, closing) {
  const month = monthIndex(monthName) + 1;
  const closingYear = Number(closing.slice(0, 4));
  const closingMonth = Number(closing.slice(5, 7));
  const year = month > closingMonth ? closingYear - 1 : closingYear;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Removes anything that may be an account number: masked numbers
// ("ROGERS ******1234", "ROGERS *123456789"), "AC123456789", and any run of
// 7 or more digits (customer, tenant and booking numbers). Short store
// numbers stay.
const ACCOUNT_LIKE = /[*X]{3,}\s?\d+|\*\d{4,}|\bAC#?\s?\d+|\d{7,}/gi;
function scrub(text) {
  return String(text || '').replace(ACCOUNT_LIKE, '').replace(/\s+/g, ' ').trim();
}

// Splits a statement description into the merchant and the trailing place.
// Statements pad the place with a run of spaces ("METRO 63     TORONTO"), so
// the last run of two or more spaces is the split; with no run, the whole
// text is the merchant. Simplii Visa runs the city and province together
// ("ALI'S NF #7047      TORONTO    ON"), so a trailing province is taken too.
function splitMerchant(description) {
  const raw = String(description || '').replace(ACCOUNT_LIKE, '').trim();
  let merchant = raw;
  let location = '';
  const province = raw.match(/^(.*\S)\s+([A-Z][A-Za-z.'\- ]*?)\s+(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)$/);
  const split = raw.match(/^(.*\S)\s{2,}(\S.*)$/);
  if (province && /\s{2,}/.test(raw)) {
    const head = raw.slice(0, raw.length - province[3].length).trim();
    const inner = head.match(/^(.*\S)\s{2,}(\S.*)$/);
    merchant = inner ? inner[1] : head;
    location = `${inner ? inner[2] : ''} ${province[3]}`.trim();
  } else if (split) {
    merchant = split[1];
    location = split[2];
  }
  return { merchant: scrub(merchant), location: scrub(location) };
}

// Cleaned description for duplicate keys: lower case, letters and digits.
function cleanDescription(text) {
  return scrub(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Kinds. One table, checked top to bottom; the first rule that fits wins.
// `on` limits a rule to card or bank accounts; `sign` limits it to money out
// (+1) or money in (-1). Card lines that fit no rule are purchases or
// refunds by sign; bank lines that fit no rule are unknown.
// ---------------------------------------------------------------------------
const KIND_RULES = [
  // Paying a card: the card's own payment line, and the payment as it
  // leaves chequing.
  { kind: 'card-payment', on: 'card', match: /PAYMENT RECEIVED|PAYMENT THANK YOU|PAIEMENT MERCI/i },
  { kind: 'card-payment', on: 'bank', sign: 1, match: /^(EFT )?(AMERICAN EXPRESS|AMEX BANK OF CANADA)|^VISA, (CIBC|TD)|^VISA SIMPLII|^(EFT )?CIBC CARD PRODUCTS|MASTERCARD|^MBNA$|^CANADIAN TIRE BANK|^CDN TIRE$|^EFT PCF PAD|^PC FINANCIAL/i },
  // A card payment handed back: a correction or a reversed payment.
  { kind: 'card-payment', on: 'bank', sign: -1, match: /^BILL CORRECTION VISA|^EFT REVERSAL (AMERICAN EXPRESS|AMEX|CIBC CARD)/i },
  // Money moved between his own accounts, and card balance moved into or
  // out of an Amex installment plan (not a refund, not a purchase).
  { kind: 'transfer', on: 'card', match: /INSTALLMENT PLAN FOR|INSTALLMENT PROGRAM/i },
  { kind: 'transfer', on: 'bank', match: /WEALTHSIMPLE|INTERNET TRANSFER|^TRANSFER (IN|OUT|TO|FROM)\b|^TFR|^BANK TRANSFER|^QUESTRADE|^TANGERINE|^EQ BANK|^EQUITABLE BANK|^RIGHT OF OFFSET|PERSONAL BT$/i },
  { kind: 'fee', match: /MEMBERSHIP FEE|INSTALLMENT FEE|OVERLIMIT FEE|ANNUAL FEE|LATE PAYMENT|SERVICE CHARGE|NSF (FEE|S\/C)|OVERDRAFT (FEE|PROTECTION CHARGE)|INTERAC CHARGE|^FEE\b/i },
  { kind: 'interest', match: /^INTEREST\b|INTEREST CHARGE|PURCHASE INTEREST/i },
  { kind: 'income', on: 'bank', sign: -1, match: /PAYROLL|PAY\/PAY|SALARY|CANADA LIFE|ASSURE HEALTH|MANULIFE|SUN LIFE|GREEN SHIELD|CANADA (GST|CCB|EI|FPT|PRO)|GST\/HST|CANADA REVENUE|^CRA\b|ONTARIO (TRILLIUM|ENERGY)|EMPLOYMENT INS|GOVERNMENT|GC \d|FEDERAL PMT|PROV\/FED|^CANADA$|^GSCI|^ADMIN BY CL|DIRECT DEPOSIT/i },
  { kind: 'cash', match: /\bATM\b|\bABM\b|CASH WITHDRAWAL|WITHDRAWAL - ABM|INTERAC CASH/i },
  { kind: 'etransfer-person', on: 'bank', match: /INTERAC E-TRANSFER|E-TRANSFER/i },
  // Medallion-135Rose is the monthly rent; other Medallion lines are small
  // landlord charges and stay unknown.
  { kind: 'rent', on: 'bank', match: /^MEDALLION-|PAYQUAD|\bRENT\b/i },
  { kind: 'bill', match: /HYDRO|INSURANCE|NSLSC|STUDENT LOAN|CRA REVENUE - TAX|ROGERS|\bBELL\b|KOODO|\bFIDO\b|TELUS|FREEDOM MOBILE|VIRGIN PLUS|PUBLIC MOBILE|ENBRIDGE|MANULIFE|INTERNET|TEKSAVVY|START\.CA/i },
  { kind: 'reload', match: /PRESTO (MOBL|AUTL|WEB|AUTOLOAD|ONLINE)|^PRESTO$|STARBUCKS 800-782|STARBUCKS.*(CARD|RELOAD)|TIM HORTONS.*(CARD|RELOAD|APP)|UBER CASH|GIFT ?CARD/i },
];

// `tx.amount` is positive for money out. `type` is 'card' or 'bank'.
function classify(tx, type) {
  const text = `${tx.description || ''}`;
  const sign = tx.amount >= 0 ? 1 : -1;
  const rule = KIND_RULES.find((r) => (!r.on || r.on === type)
    && (!r.sign || r.sign === sign)
    && r.match.test(text));
  if (rule) return rule.kind;
  if (type === 'card') return tx.amount >= 0 ? 'purchase' : 'refund';
  return 'unknown';
}

function makeTransaction(fields) {
  const { merchant, location } = splitMerchant(fields.description);
  return {
    account: fields.account,
    date: fields.date,
    postedDate: fields.postedDate || null,
    description: scrub(fields.description),
    merchant: fields.merchant != null ? splitMerchant(fields.merchant).merchant : merchant,
    location: fields.location != null ? fields.location : location,
    amount: cents(fields.amount),
    currency: 'CAD',
    foreignAmount: fields.foreignAmount ?? null,
    foreignCurrency: fields.foreignCurrency ?? null,
    kind: null,
    sourceFile: fields.sourceFile,
    ref: fields.ref || null,
  };
}

// ---------------------------------------------------------------------------
// Amex CSV (downloaded from the website). Positive amounts are charges.
// ---------------------------------------------------------------------------
function csvDate(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!match || monthIndex(match[2]) < 0) return null;
  return `${match[3]}-${pad(monthIndex(match[2]) + 1)}-${pad(match[1])}`;
}

function parseAmexCsv(text, { account, sourceFile }) {
  const rows = parseCsvText(text, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
  return rows.map((row) => {
    const foreign = String(row['Foreign Spend Amount'] || '').trim().match(/^(-?[\d,]+\.?\d*)\s+([A-Z]{3})$/);
    const city = String(row['City / Province'] || '').replace(/\s+/g, ' ').trim();
    const tx = makeTransaction({
      account,
      date: csvDate(row.Date),
      postedDate: csvDate(row['Date Processed']),
      description: row.Description,
      merchant: row.Merchant || row.Description,
      location: [city, row.Country].filter(Boolean).join(', '),
      amount: parseAmount(row.Amount),
      foreignAmount: foreign ? parseAmount(foreign[1]) : null,
      foreignCurrency: foreign ? foreign[2] : null,
      sourceFile,
      ref: String(row.Reference || '').replace(/^'+|'+$/g, '') || null,
    });
    tx.kind = classify(tx, 'card');
    return tx;
  });
}

// ---------------------------------------------------------------------------
// Amex PDF (pdftotext -layout). Sections, in statement order:
//   New Payments, New Plan It Installment Plans Created (a record only),
//   Plan It Installment Program Monthly Fees, Other Plan It Installment
//   Program Transactions (inside the plan, a record only), New Transactions,
//   Other Account Transactions.
// The balance identity: New = Previous + payments + monthly fees + new
// transactions + other account transactions + the summary's Monthly
// Installments line (installments are billed with no line of their own).
// ---------------------------------------------------------------------------
const AMEX_SECTIONS = [
  { name: 'payments', start: /^New Payments/, total: /^Total of Payment Activity/ },
  { name: 'planCreated', record: true, start: /^New Plan It Installment Plans Created/, total: /^Total Amount Moved to Plan It/ },
  { name: 'planFees', start: /^Plan It Installment Program Monthly Fees/, total: /^Total of Plan It Installment Program Monthly Fees/ },
  { name: 'planOther', record: true, start: /^Other Plan It Installment Program Transactions/, total: /^Total of Other Plan It/ },
  { name: 'newTransactions', start: /^New Transactions for/, total: /^Total of New Transactions/ },
  { name: 'other', start: /^Other Account Transactions/, total: /^Total of Other Account Transactions/ },
];
const AMEX_SUMMARY = {
  previous: /Previous Balance/, payments: /Less Payments/, otherCredits: /Less Other Credits/,
  interest: /Plus\s+Interest/, purchases: /Plus\s+Purchases/, fees: /Plus\s+Fees/,
  advances: /Plus\s+Credit Advances/, otherCharges: /Plus\s+Other Charges/,
  installments: /Plus\s+Monthly Installments/, transferFromPlan: /Plus\s+Transfer from Installment/,
  newBalance: /Equals New Balance/,
};
const MONEY = /(-?)\$(-?[\d,]+\.\d{2})/;
const AMEX_LINE = /^\*?([A-Z][a-z]{2}) (\d{1,2})\s+([A-Z][a-z]{2}) (\d{1,2})\s+(.+?)\s{2,}(-?[\d,]+\.\d{2})$/;
const AMOUNT_AT_END = /\s(-?[\d,]+\.\d{2})$/;

function amexLabel(text) {
  if (/Cobalt Card/i.test(text)) return 'Amex Cobalt';
  if (/Marriott Bonvoy/i.test(text)) return 'Amex Marriott';
  if (/SimplyCash Preferred/i.test(text)) return 'Amex SimplyCash Preferred';
  if (/SimplyCash/i.test(text)) return 'Amex SimplyCash';
  return 'Amex';
}

function isAmexPdf(text) {
  return /American Express|Amex Bank of Canada/i.test(text) && /ACCOUNT SUMMARY/.test(text) && /Your Transactions/.test(text);
}

function parseAmexPdf(text, { sourceFile } = {}) {
  const account = amexLabel(text);
  const problems = [];
  const periodMatch = text.match(/Opening Date\s+Closing Date[\s\S]*?([A-Z][a-z]{2} \d{1,2}, \d{4})\s+([A-Z][a-z]{2} \d{1,2}, \d{4})/);
  const period = periodMatch ? { from: longDate(periodMatch[1]), to: longDate(periodMatch[2]) } : null;
  if (!period) return { account, period: null, transactions: [], reconciliation: { ok: false, problems: ['no statement period found'] } };

  const summary = {};
  const summaryText = (text.match(/ACCOUNT SUMMARY([\s\S]*?Equals New Balance[^\n]*)/) || [])[1] || '';
  for (const line of summaryText.split('\n')) {
    for (const [key, label] of Object.entries(AMEX_SUMMARY)) {
      const at = line.search(label);
      if (at < 0 || key in summary) continue;
      const money = line.slice(at).match(MONEY);
      if (money) summary[key] = parseAmount(`${money[1]}${money[2]}`);
    }
  }

  const sections = {};
  const transactions = [];
  const body = (text.match(/Your Transactions([\s\S]*?)(About Your Credit Limit|$)/) || [])[1] || '';
  let section = null;
  let last = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const start = AMEX_SECTIONS.find((s) => s.start.test(line));
    if (start) {
      section = start;
      sections[section.name] = sections[section.name] || { lines: [], printed: null };
      last = null;
      continue;
    }
    const totalOf = AMEX_SECTIONS.find((s) => s.total.test(line));
    if (totalOf) {
      const amount = line.match(AMOUNT_AT_END);
      sections[totalOf.name] = sections[totalOf.name] || { lines: [], printed: null };
      sections[totalOf.name].printed = amount ? parseAmount(amount[1]) : null;
      section = null;
      last = null;
      continue;
    }
    if (!section) continue;
    const match = line.match(AMEX_LINE);
    if (match) {
      const amount = parseAmount(match[6]);
      sections[section.name].lines.push(amount);
      last = null;
      if (section.record) continue;
      last = makeTransaction({
        account,
        date: dateInStatement(match[1], Number(match[2]), period.to),
        postedDate: dateInStatement(match[3], Number(match[4]), period.to),
        description: match[5],
        amount,
        sourceFile,
      });
      last.kind = section.name === 'payments' ? 'card-payment' : classify(last, 'card');
      transactions.push(last);
      continue;
    }
    if (/^[A-Z][a-z]{2} \d{1,2}\s/.test(line) && AMOUNT_AT_END.test(line)) {
      problems.push(`unread line in ${section.name}`);
      continue;
    }
    if (!last) continue;
    const reference = line.match(/^Reference\s+(\S+)/);
    const foreign = line.match(/^([A-Z][A-Z ]+?)\s+([\d,]+\.\d{2})\s+@\s+([\d.]+)/);
    if (reference) last.ref = reference[1];
    else if (foreign) {
      last.foreignCurrency = CURRENCIES[foreign[1]] || foreign[1];
      last.foreignAmount = Math.sign(last.amount || 1) * parseAmount(foreign[2]);
    }
  }

  // Checks against the printed totals.
  for (const [name, s] of Object.entries(sections)) {
    if (s.printed == null) problems.push(`${name}: no printed total`);
    else if (!close(sum(s.lines), s.printed)) problems.push(`${name}: lines add to ${sum(s.lines)}, printed ${s.printed}`);
  }
  const lineSum = (name) => sum((sections[name] || { lines: [] }).lines);
  const need = ['previous', 'newBalance', 'payments', 'purchases'];
  need.filter((key) => summary[key] == null).forEach((key) => problems.push(`summary: no ${key}`));
  if (summary.purchases != null && !close(lineSum('newTransactions'), summary.purchases)) {
    problems.push(`purchases: lines add to ${lineSum('newTransactions')}, printed ${summary.purchases}`);
  }
  if (summary.payments != null && !close(-lineSum('payments'), summary.payments)) {
    problems.push(`payments: lines add to ${-lineSum('payments')}, printed ${summary.payments}`);
  }
  if (summary.previous != null && summary.newBalance != null) {
    const expected = sum([summary.previous, lineSum('payments'), lineSum('planFees'), lineSum('newTransactions'),
      lineSum('other'), summary.installments || 0]);
    if (!close(expected, summary.newBalance)) problems.push(`new balance: lines give ${expected}, printed ${summary.newBalance}`);
  }
  return { account, period, summary, transactions, reconciliation: { ok: problems.length === 0, problems } };
}

// ---------------------------------------------------------------------------
// Simplii chequing PDF. Rows: posted date, effective date, description,
// funds out, funds in, balance. A row's sign comes from the change in the
// running balance, not from the column it sits in. Negative balances are
// printed with a trailing minus ("134.91-").
// ---------------------------------------------------------------------------
const CHEQUING_LINE = /^([A-Z][a-z]{2}) (\d{2})\s+([A-Z][a-z]{2}) (\d{2})\s+(.+?)\s{2,}([\d,]+\.\d{2}-?)(?:\s+([\d,]+\.\d{2}-?))?\s*$/;

function isSimpliiChequingPdf(text) {
  return /statement period:/.test(text) && /BALANCE FORWARD/.test(text) && /closing balance/.test(text);
}

function parseSimpliiChequingPdf(text, { sourceFile, account = 'Simplii chequing' } = {}) {
  const problems = [];
  const periodMatch = text.match(/statement period:\s+([A-Za-z]+ \d{1,2}, \d{4})\s*-\s*([A-Za-z]+ \d{1,2}, \d{4})/);
  const period = periodMatch ? { from: longDate(periodMatch[1]), to: longDate(periodMatch[2]) } : null;
  if (!period) return { account, period: null, transactions: [], reconciliation: { ok: false, problems: ['no statement period found'] } };
  const printed = {
    out: parseAmount((text.match(/total funds out\s+([\d,]+\.\d{2}-?)/) || [])[1] || 'x'),
    in: parseAmount((text.match(/total funds in\s+([\d,]+\.\d{2}-?)/) || [])[1] || 'x'),
    closing: parseAmount((text.match(/closing balance\s+([\d,]+\.\d{2}-?)/) || [])[1] || 'x'),
  };

  const transactions = [];
  let opening = null;
  let balance = null;
  let inBody = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^details$/.test(line) || /BALANCE FORWARD/.test(line)) inBody = true;
    if (/end of transactions/.test(line)) inBody = false;
    if (!inBody) continue;
    const match = line.match(CHEQUING_LINE);
    if (!match) {
      if (/^[A-Z][a-z]{2} \d{2}\s/.test(line)) problems.push('unread transaction line');
      continue;
    }
    // Chequing lines carry payer and member numbers ("PAYERCO123456").
    const description = match[5].replace(/\d{6,}/g, '').trim();
    if (/^BALANCE FORWARD/.test(description)) {
      opening = parseAmount(match[7] || match[6]);
      balance = opening;
      continue;
    }
    if (!match[7]) {
      problems.push('row without a running balance');
      continue;
    }
    const amount = parseAmount(match[6]);
    const after = parseAmount(match[7]);
    if (balance == null) {
      problems.push('row before balance forward');
      balance = after;
      continue;
    }
    const change = cents(balance - after); // positive = money out
    if (!close(Math.abs(change), amount)) problems.push(`running balance: ${description.slice(0, 20)} changes balance by ${change}, row shows ${amount}`);
    balance = after;
    const tx = makeTransaction({
      account,
      date: dateInStatement(match[3], Number(match[4]), period.to),
      postedDate: dateInStatement(match[1], Number(match[2]), period.to),
      description,
      amount: close(Math.abs(change), amount) ? change : amount,
      sourceFile,
    });
    tx.kind = classify(tx, 'bank');
    transactions.push(tx);
  }

  const out = sum(transactions.filter((t) => t.amount > 0).map((t) => t.amount));
  const inn = sum(transactions.filter((t) => t.amount < 0).map((t) => -t.amount));
  if (opening == null) problems.push('no balance forward');
  if (printed.out == null || !close(out, printed.out)) problems.push(`funds out: lines add to ${out}, printed ${printed.out}`);
  if (printed.in == null || !close(inn, printed.in)) problems.push(`funds in: lines add to ${inn}, printed ${printed.in}`);
  if (printed.closing == null || !close(balance ?? NaN, printed.closing)) problems.push(`closing balance: rows end at ${balance}, printed ${printed.closing}`);
  if (opening != null && printed.closing != null && !close(cents(opening - out + inn), printed.closing)) {
    problems.push('opening minus out plus in does not give the closing balance');
  }
  return { account, period, opening, closing: printed.closing, transactions, reconciliation: { ok: problems.length === 0, problems } };
}

// ---------------------------------------------------------------------------
// Formats only listed in the inventory (the statement period and a label).
// ---------------------------------------------------------------------------
function describeStatement(text) {
  if (isAmexPdf(text)) return { format: 'amex-pdf', label: amexLabel(text) };
  if (isSimpliiChequingPdf(text)) return { format: 'simplii-chequing-pdf', label: 'Simplii chequing' };
  let match = text.match(/([A-Z][a-z]+ \d{1,2}(?:, \d{4})?) to ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (/Cash Back Visa/i.test(text) && match) {
    const to = longDate(match[2]);
    const from = longDate(/\d{4}/.test(match[1]) ? match[1] : `${match[1]}, ${to.slice(0, 4)}`);
    return { format: 'simplii-visa-pdf', label: 'Simplii Cash Back Visa', period: { from: from > to ? `${Number(from.slice(0, 4)) - 1}${from.slice(4)}` : from, to } };
  }
  match = text.match(/From ([A-Z][a-z]+ \d{1,2}, \d{4}) to ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (/Royal Bank of Canada/.test(text) && match) {
    return { format: 'rbc-chequing-pdf', label: 'RBC chequing', period: { from: longDate(match[1]), to: longDate(match[2]) }, noActivity: /No activity for this period/.test(text) };
  }
  if (/Wealthsimple/i.test(text)) {
    match = text.match(/from ([A-Z][a-z]+ \d{2}, \d{4}) to ([A-Z][a-z]+ \d{2}, \d{4})/);
    return { format: 'wealthsimple-pdf', label: 'Wealthsimple', period: match ? { from: longDate(match[1]), to: longDate(match[2]) } : null };
  }
  const printout = /View eStatements|Search by Month/.test(text);
  if (printout) {
    const dates = [...text.matchAll(/(?:^|\s)([A-Z][a-z]{2} \d{1,2}, 20\d{2})\s/g)].map((m) => longDate(m[1])).filter(Boolean).sort();
    const label = /TD Canada Trust|Search by Month/.test(text) && !/Simplii/i.test(text) ? 'TD chequing'
      : /Joint \(/.test(text) ? 'Simplii joint chequing' : 'Simplii chequing';
    return { format: 'online-banking-printout', label, period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null };
  }
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters < text.length * 0.2) return { format: 'unreadable-pdf', label: null };
  return { format: 'unknown-pdf', label: null };
}

// ---------------------------------------------------------------------------
// Duplicates across sources. The key is the Reference when there is one;
// otherwise the date, amount, cleaned description and how many times that
// same line already appeared that day. A month comes from its CSV when one
// exists, otherwise from its PDF.
// ---------------------------------------------------------------------------
function duplicateKeys(transactions) {
  const seen = new Map();
  return transactions.map((tx) => {
    const base = `${tx.account}|${tx.date}|${tx.amount.toFixed(2)}|${cleanDescription(tx.description)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ref: tx.ref ? `${tx.account}|ref|${tx.ref}` : null, line: `${base}|${n}` };
  });
}

// `sources` is a list of { kind: 'csv' | 'pdf', month: 'YYYY-MM', transactions }.
// Returns { transactions, dropped } where dropped counts lines left out.
function dedupeStatements(sources) {
  const csvMonths = new Set(sources.filter((s) => s.kind === 'csv').map((s) => `${s.account}|${s.month}`));
  const seenRefs = new Set();
  const seenLines = new Set();
  const transactions = [];
  let droppedMonths = 0;
  let droppedLines = 0;
  // CSVs first, so a line in both keeps its CSV form.
  const ordered = [...sources].sort((a, b) => (a.kind === 'csv' ? 0 : 1) - (b.kind === 'csv' ? 0 : 1));
  for (const source of ordered) {
    if (source.kind === 'pdf' && csvMonths.has(`${source.account}|${source.month}`)) {
      droppedMonths += source.transactions.length;
      continue;
    }
    // Occurrence numbers count within one source, so two real identical
    // coffees on one day stay two, while the same pair in a second source
    // (an overlapping statement or a copied file) is dropped.
    duplicateKeys(source.transactions).forEach((key, index) => {
      if ((key.ref && seenRefs.has(key.ref)) || seenLines.has(key.line)) {
        droppedLines += 1;
        return;
      }
      if (key.ref) seenRefs.add(key.ref);
      seenLines.add(key.line);
      transactions.push(source.transactions[index]);
    });
  }
  return { transactions, dropped: { coveredByCsv: droppedMonths, duplicateLines: droppedLines } };
}

module.exports = {
  KIND_RULES,
  classify,
  parseAmount,
  splitMerchant,
  cleanDescription,
  dateInStatement,
  parseAmexCsv,
  parseAmexPdf,
  parseSimpliiChequingPdf,
  describeStatement,
  isAmexPdf,
  isSimpliiChequingPdf,
  dedupeStatements,
};

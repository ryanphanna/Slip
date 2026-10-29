const { countedDate } = require('./query');
const { normalizeMerchant } = require('./validate');

// Published till-redemption rates, checked 2026-10-29. Promo redemption
// events only ever beat these, so the value shown is a floor ("at least").
// Update `points`/`dollars` here when a program changes its rate.
// Stores that share one points balance. PC Optimum is confirmed by the data:
// Loblaws, Superstore, No Frills and Shoppers receipts continue one running
// balance. Any other store is its own program, named after the store.
const PROGRAMS = [
  { name: 'PC Optimum', rate: { points: 10000, dollars: 10 }, stores: ['loblaws', 'superstore', 'realcanadiansuperstore', 'nofrills', 'shoppersdrugmart', 'shoppers', 'fortinos', 'zehrs', 'valumart', 'yourindependentgrocer', 'wholesaleclub'] },
  { name: 'Scene+', rate: { points: 1000, dollars: 10 }, stores: ['freshco', 'sobeys', 'foodland', 'safeway'] },
  { name: 'Be Well', rate: { points: 25000, dollars: 10 }, stores: ['rexall'] },
  { name: 'moi', rate: { points: 500, dollars: 4 }, stores: ['metro', 'foodbasics'] },
];

const storeKey = (merchant) => String(merchant || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "NOFRILLS", "nofrills" and "No Frills" are one store; show the mixed-case spelling.
function displayName(names) {
  const list = [...names];
  return list.find((name) => name !== name.toUpperCase() && name !== name.toLowerCase()) || list[0];
}

function programOf(merchant) {
  const key = storeKey(merchant);
  if (!key) return null;
  // Whole name, or the name plus a store number ("metro123"), so "Metrolinx" is not Metro.
  const matches = (store) => key === store || (key.startsWith(store) && /^\d/.test(key.slice(store.length)));
  const known = PROGRAMS.find((program) => program.stores.some(matches));
  return known ? known.name : normalizeMerchant(merchant);
}

const MONTHS_SHOWN = 6;

// Latest balance and recent points earned per program, from receipts that
// printed points. The balance is the one on the most recent receipt (by the
// date it counts on), with that receipt's date and store so a misread
// balance can be traced back.
function pointsFromDocs(docs, today = new Date()) {
  const programs = new Map();
  for (const doc of docs) {
    const balance = typeof doc.loyaltyPointsBalance === 'number' ? doc.loyaltyPointsBalance : null;
    const earned = typeof doc.loyaltyPointsEarned === 'number' ? doc.loyaltyPointsEarned : null;
    if (balance == null && earned == null) continue;
    const name = programOf(doc.merchant);
    const day = countedDate(doc);
    if (!name || !day) continue;
    const program = programs.get(name) || { name, stores: new Map(), receiptCount: 0, latest: null, earnedByMonth: {} };
    const store = normalizeMerchant(doc.merchant);
    const spellings = program.stores.get(storeKey(store)) || new Set();
    program.stores.set(storeKey(store), spellings.add(store));
    program.receiptCount += 1;
    const sent = doc.createdAt?.toMillis?.() || 0;
    if (balance != null && (!program.latest || day > program.latest.day || (day === program.latest.day && sent > program.latest.sent))) {
      program.latest = { day, sent, balance, storeKey: storeKey(store), receiptId: doc.id };
    }
    if (earned != null && earned > 0) {
      const month = day.slice(0, 7);
      program.earnedByMonth[month] = (program.earnedByMonth[month] || 0) + earned;
    }
    programs.set(name, program);
  }

  const months = [];
  for (let offset = MONTHS_SHOWN - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  }

  return [...programs.values()]
    .map((program) => {
      const rate = PROGRAMS.find((known) => known.name === program.name)?.rate || null;
      const balance = program.latest ? program.latest.balance : null;
      return {
      name: program.name,
      rate,
      worthAtLeast: rate && balance != null ? Math.round((balance * rate.dollars / rate.points) * 100) / 100 : null,
      stores: [...program.stores.values()].map(displayName).sort(),
      receiptCount: program.receiptCount,
      balance: program.latest ? program.latest.balance : null,
      balanceDate: program.latest ? program.latest.day : null,
      balanceStore: program.latest ? displayName(program.stores.get(program.latest.storeKey)) : null,
      balanceReceiptId: program.latest ? program.latest.receiptId : null,
      earnedByMonth: months.map((monthKey) => ({ monthKey, points: Math.round((program.earnedByMonth[monthKey] || 0) * 100) / 100 })),
      };
    })
    // Programs with a balance first, then most recently updated.
    .sort((a, b) => (b.balance != null) - (a.balance != null) || (b.balanceDate || '').localeCompare(a.balanceDate || '') || a.name.localeCompare(b.name));
}

module.exports = { programOf, pointsFromDocs, PROGRAMS };

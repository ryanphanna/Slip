const admin = require('firebase-admin');
const { DEFAULT_CURRENCY, currencyOf } = require('./money');

function findLatestReceiptForSender(snapshotDocs, from) {
  for (const doc of snapshotDocs) {
    if (doc.get('from') === from) return doc.data();
  }
  return null;
}

function aggregateOneCurrency(docs) {
  let total = 0;
  const categories = {};

  for (const d of docs) {
    if (d.total == null) continue;
    total += d.total;

    if (Array.isArray(d.items) && d.items.length > 0) {
      let sumItems = 0;
      for (const item of d.items) {
        const itemCat = item.category || d.category || 'Other';
        const itemPrice = item.price || 0;
        categories[itemCat] = (categories[itemCat] || 0) + itemPrice;
        sumItems += itemPrice;
      }
      // Allocate the difference (tax/tips/rounding) to the main category
      const diff = d.total - sumItems;
      if (Math.abs(diff) > 0.001) {
        const mainCat = d.category || 'Other';
        categories[mainCat] = (categories[mainCat] || 0) + diff;
      }
    } else {
      const cat = d.category || 'Other';
      categories[cat] = (categories[cat] || 0) + d.total;
    }
  }

  // Round values to 2 decimal places
  const roundedCategories = {};
  for (const [cat, amt] of Object.entries(categories)) {
    roundedCategories[cat] = Math.round(amt * 100) / 100;
  }

  return {
    total: Math.round(total * 100) / 100,
    categories: roundedCategories,
  };
}

// Totals are CAD (missing currency = CAD). Other currencies are never added in;
// they appear only under `byCurrency` as { total, categories, count } (key
// omitted when there are none).
function aggregateSpendingByCategory(docs) {
  const primary = [];
  const others = {};
  for (const d of docs) {
    const code = currencyOf(d);
    if (code === DEFAULT_CURRENCY) primary.push(d);
    else (others[code] = others[code] || []).push(d);
  }
  const result = aggregateOneCurrency(primary);
  const codes = Object.keys(others);
  if (codes.length > 0) {
    result.byCurrency = {};
    for (const code of codes) {
      result.byCurrency[code] = { ...aggregateOneCurrency(others[code]), count: others[code].length };
    }
  }
  return result;
}

// Receipt count for the CAD headline, so "$X across N receipts" matches X.
function countPrimary(docs) {
  return docs.filter((d) => currencyOf(d) === DEFAULT_CURRENCY).length;
}

async function getMonthlyStats(from) {
  const db = admin.firestore();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', startOfMonth)
    .get();

  const docs = snapshot.docs.map(doc => doc.data());
  const { total, categories, byCurrency } = aggregateSpendingByCategory(docs);

  return { total, categories, count: countPrimary(docs), ...(byCurrency ? { byCurrency } : {}), month: now.toLocaleString('default', { month: 'long' }) };
}

async function getSpendingStats(from, startDate) {
  const db = admin.firestore();
  let query = db.collection('receipts').where('from', '==', from);
  if (startDate) query = query.where('createdAt', '>=', startDate);
  const snapshot = await query.get();
  const docs = snapshot.docs.map(doc => doc.data());
  const { total, categories, byCurrency } = aggregateSpendingByCategory(docs);
  return { total, categories, count: countPrimary(docs), ...(byCurrency ? { byCurrency } : {}) };
}

async function getLastReceipt(from) {
  const db = admin.firestore();
  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].data();
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function isMonthKey(value) {
  return typeof value === 'string' && MONTH_KEY.test(value);
}

// "2026-01" -> "2025-12"; "2026-09" -> "2026-10" with offset 1.
function shiftMonthKey(monthKey, offset) {
  const [year, month] = monthKey.split('-').map(Number);
  const index = year * 12 + (month - 1) + offset;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function monthName(monthKey) {
  return MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1];
}

// One month's stats from already-loaded receipt data, filtered on the
// purchase date. This is the single month rule the monthly recap (SMS and
// Notifications card) and the web recap page share, so their numbers match.
function monthStatsFromDocs(docs, monthKey) {
  const startDate = `${monthKey}-01`;
  const endDate = `${shiftMonthKey(monthKey, 1)}-01`;
  const monthDocs = docs.filter((doc) => typeof doc.date === 'string' && doc.date >= startDate && doc.date < endDate);
  const { total, categories, byCurrency } = aggregateSpendingByCategory(monthDocs);
  return { total, categories, count: countPrimary(monthDocs), ...(byCurrency ? { byCurrency } : {}), month: monthName(monthKey), monthKey, docs: monthDocs };
}

async function loadAllReceipts(from) {
  const snapshot = await admin.firestore().collection('receipts').where('from', '==', from).get();
  return snapshot.docs;
}

async function getLastMonthStats(from) {
  const now = new Date();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthKey = formatDate(startOfLastMonth).slice(0, 7);
  const docs = (await loadAllReceipts(from)).map((doc) => doc.data());
  const { docs: _monthDocs, ...stats } = monthStatsFromDocs(docs, monthKey);
  return stats;
}

function formatDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), '01'].join('-');
}

module.exports = { getMonthlyStats, getLastMonthStats, monthStatsFromDocs, loadAllReceipts, isMonthKey, shiftMonthKey, monthName, getSpendingStats, getLastReceipt, findLatestReceiptForSender, aggregateSpendingByCategory };

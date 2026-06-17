const admin = require('firebase-admin');

// Tool declarations in Gemini function-calling format
const TOOL_DECLARATIONS = [
  {
    name: 'getSpendingTotal',
    description: 'Get the total amount spent across all receipts, optionally filtered by date range.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startDate: { type: 'STRING', description: 'Start date ISO 8601 e.g. 2025-01-01 (inclusive). Omit for all time.' },
        endDate:   { type: 'STRING', description: 'End date ISO 8601 e.g. 2025-12-31 (inclusive). Omit for all time.' },
      },
    },
  },
  {
    name: 'getSpendingByCategory',
    description: 'Get spending broken down by category, optionally filtered by date range.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startDate: { type: 'STRING', description: 'Start date ISO 8601. Omit for all time.' },
        endDate:   { type: 'STRING', description: 'End date ISO 8601. Omit for all time.' },
      },
    },
  },
  {
    name: 'getTopMerchants',
    description: 'Get the top merchants ranked by total spend, optionally filtered by date range.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startDate: { type: 'STRING', description: 'Start date ISO 8601. Omit for all time.' },
        endDate:   { type: 'STRING', description: 'End date ISO 8601. Omit for all time.' },
        limit:     { type: 'NUMBER', description: 'Max merchants to return. Defaults to 10.' },
      },
    },
  },
  {
    name: 'getRecentReceipts',
    description: 'Get the most recent receipts, optionally filtered by merchant name.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit:    { type: 'NUMBER', description: 'Number of receipts to return. Defaults to 10.' },
        merchant: { type: 'STRING', description: 'Filter to receipts from this merchant (case-insensitive partial match). Omit for all merchants.' },
      },
    },
  },
  {
    name: 'getMonthlySummary',
    description: 'Get a spending summary for a specific calendar month.',
    parameters: {
      type: 'OBJECT',
      properties: {
        year:  { type: 'NUMBER', description: 'Four-digit year e.g. 2025. Defaults to current year.' },
        month: { type: 'NUMBER', description: 'Month 1–12. Defaults to current month.' },
      },
    },
  },
];

function buildDateRange(startDate, endDate) {
  const constraints = {};
  if (startDate) constraints.start = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    constraints.end = end;
  }
  return constraints;
}

async function queryReceipts({ startDate, endDate } = {}) {
  const db = admin.firestore();
  const { start, end } = buildDateRange(startDate, endDate);

  // Single-user app — no need to filter by `from`, avoids composite index requirements
  let q = db.collection('receipts');
  if (start) q = q.where('createdAt', '>=', start);
  if (end)   q = q.where('createdAt', '<=', end);

  const snapshot = await q.get();
  return snapshot.docs.map(d => d.data());
}

async function getSpendingTotal({ startDate, endDate } = {}) {
  const docs = await queryReceipts({ startDate, endDate });
  let total = 0;
  let count = 0;
  for (const d of docs) {
    if (d.total != null) { total += d.total; count++; }
  }
  return { total: Math.round(total * 100) / 100, receiptCount: count };
}

async function getSpendingByCategory({ startDate, endDate } = {}) {
  const docs = await queryReceipts({ startDate, endDate });
  const categories = {};
  let total = 0;
  for (const d of docs) {
    if (d.total == null) continue;
    const cat = d.category || 'Other';
    categories[cat] = Math.round(((categories[cat] || 0) + d.total) * 100) / 100;
    total += d.total;
  }
  const sorted = Object.entries(categories)
    .sort(([, a], [, b]) => b - a)
    .map(([category, amount]) => ({ category, amount }));
  return { categories: sorted, total: Math.round(total * 100) / 100, receiptCount: docs.length };
}

async function getTopMerchants({ startDate, endDate, limit = 10 } = {}) {
  const docs = await queryReceipts({ startDate, endDate });
  const merchants = {};
  for (const d of docs) {
    if (!d.merchant || d.total == null) continue;
    if (!merchants[d.merchant]) merchants[d.merchant] = { total: 0, visits: 0 };
    merchants[d.merchant].total  = Math.round((merchants[d.merchant].total + d.total) * 100) / 100;
    merchants[d.merchant].visits += 1;
  }
  return Object.entries(merchants)
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, limit)
    .map(([merchant, stats]) => ({ merchant, ...stats }));
}

async function getRecentReceipts({ limit = 10, merchant } = {}) {
  const db = admin.firestore();
  let q = db.collection('receipts').orderBy('createdAt', 'desc');

  const snapshot = await q.limit(merchant ? 100 : limit).get();
  let docs = snapshot.docs.map(d => d.data());

  if (merchant) {
    const needle = merchant.toLowerCase();
    docs = docs.filter(d => d.merchant?.toLowerCase().includes(needle)).slice(0, limit);
  }

  return docs.map(d => ({
    merchant:  d.merchant,
    total:     d.total,
    category:  d.category,
    date:      d.date,
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    currency:  d.currency,
  }));
}

async function getMonthlySummary({ year, month } = {}) {
  const now = new Date();
  const y = year  || now.getFullYear();
  const m = month || (now.getMonth() + 1);

  const start = new Date(y, m - 1, 1);
  const end   = new Date(y, m, 0, 23, 59, 59, 999); // last day of month

  const docs = await queryReceipts({ startDate: start.toISOString(), endDate: end.toISOString() });

  const categories = {};
  const merchantMap = {};
  let total = 0;
  for (const d of docs) {
    if (d.total == null) continue;
    total += d.total;
    const cat = d.category || 'Other';
    categories[cat] = Math.round(((categories[cat] || 0) + d.total) * 100) / 100;
    if (d.merchant) {
      merchantMap[d.merchant] = Math.round(((merchantMap[d.merchant] || 0) + d.total) * 100) / 100;
    }
  }

  const topMerchants = Object.entries(merchantMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([merchant, amount]) => ({ merchant, amount }));

  return {
    year: y,
    month: m,
    monthName: start.toLocaleString('default', { month: 'long' }),
    total: Math.round(total * 100) / 100,
    receiptCount: docs.length,
    categories: Object.entries(categories).sort(([,a],[,b]) => b - a).map(([category, amount]) => ({ category, amount })),
    topMerchants,
  };
}

async function executeTool(name, args) {
  switch (name) {
    case 'getSpendingTotal':      return getSpendingTotal(args);
    case 'getSpendingByCategory': return getSpendingByCategory(args);
    case 'getTopMerchants':       return getTopMerchants(args);
    case 'getRecentReceipts':     return getRecentReceipts(args);
    case 'getMonthlySummary':     return getMonthlySummary(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOL_DECLARATIONS, executeTool };

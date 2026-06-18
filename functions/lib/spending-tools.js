const admin = require('firebase-admin');

// Tool declarations in Gemini function-calling format
const TOOL_DECLARATIONS = [
  {
    name: 'getSpendingTotal',
    description: 'Get the total amount spent across all receipts, optionally filtered by date range, merchant, or category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startDate: { type: 'STRING', description: 'Start date ISO 8601 e.g. 2025-01-01 (inclusive). Omit for all time.' },
        endDate:   { type: 'STRING', description: 'End date ISO 8601 e.g. 2025-12-31 (inclusive). Omit for all time.' },
        merchant:  { type: 'STRING', description: 'Filter to receipts from this merchant (case-insensitive partial match). Omit for all merchants.' },
        category:  { type: 'STRING', description: 'Filter to receipts in this category (case-insensitive exact match). Omit for all categories.' },
      },
    },
  },
  {
    name: 'getSpendingByCategory',
    description: 'Get spending broken down by category, optionally filtered by date range or merchant.',
    parameters: {
      type: 'OBJECT',
      properties: {
        startDate: { type: 'STRING', description: 'Start date ISO 8601. Omit for all time.' },
        endDate:   { type: 'STRING', description: 'End date ISO 8601. Omit for all time.' },
        merchant:  { type: 'STRING', description: 'Filter to receipts from this merchant (case-insensitive partial match). Omit for all merchants.' },
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
  {
    name: 'searchReceipts',
    description: 'Search receipts by matching a text query against merchant, category, subcategory, or items, with optional amount and date filters.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query:      { type: 'STRING', description: 'Search term to match against merchant, category, subcategory, or item names (case-insensitive partial match). Omit for no text filter.' },
        minAmount:  { type: 'NUMBER', description: 'Minimum total amount.' },
        maxAmount:  { type: 'NUMBER', description: 'Maximum total amount.' },
        startDate:  { type: 'STRING', description: 'Start date ISO 8601. Omit for all time.' },
        endDate:    { type: 'STRING', description: 'End date ISO 8601. Omit for all time.' },
        limit:      { type: 'NUMBER', description: 'Max receipts to return. Defaults to 10.' },
      },
    },
  },
  {
    name: 'setCategoryBudget',
    description: 'Set or update the monthly budget limit for a specific spending category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', description: 'The spending category name (e.g. Grocery, Health, Home, Takeout/Dining, etc.).' },
        limit:    { type: 'NUMBER', description: 'The monthly budget limit amount.' },
      },
      required: ['category', 'limit'],
    },
  },
  {
    name: 'getBudgetStatus',
    description: 'Get the status of all category budgets for the current month, showing limit, spent, and remaining amounts.',
    parameters: {
      type: 'OBJECT',
      properties: {},
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

async function queryReceipts({ startDate, endDate, merchant, category } = {}) {
  const db = admin.firestore();
  const { start, end } = buildDateRange(startDate, endDate);

  // Single-user app — no need to filter by `from`, avoids composite index requirements
  let q = db.collection('receipts');
  if (start) q = q.where('createdAt', '>=', start);
  if (end)   q = q.where('createdAt', '<=', end);

  const snapshot = await q.get();
  let docs = snapshot.docs.map(d => d.data());

  if (merchant) {
    const needle = merchant.toLowerCase();
    docs = docs.filter(d => d.merchant?.toLowerCase().includes(needle));
  }
  if (category) {
    const needle = category.toLowerCase();
    docs = docs.filter(d => d.category?.toLowerCase() === needle || d.subCategory?.toLowerCase() === needle);
  }

  return docs;
}

async function getSpendingTotal({ startDate, endDate, merchant, category } = {}) {
  const docs = await queryReceipts({ startDate, endDate, merchant, category });
  let total = 0;
  let count = 0;
  for (const d of docs) {
    if (d.total != null) { total += d.total; count++; }
  }
  return { total: Math.round(total * 100) / 100, receiptCount: count };
}

async function getSpendingByCategory({ startDate, endDate, merchant } = {}) {
  const docs = await queryReceipts({ startDate, endDate, merchant });
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

async function searchReceipts({ query, minAmount, maxAmount, startDate, endDate, limit = 10 } = {}) {
  const docs = await queryReceipts({ startDate, endDate });
  let filtered = docs;

  if (query) {
    const needle = query.toLowerCase();
    filtered = filtered.filter(d => {
      const matchMerchant = d.merchant?.toLowerCase().includes(needle);
      const matchCategory = d.category?.toLowerCase().includes(needle);
      const matchSubCategory = d.subCategory?.toLowerCase().includes(needle);
      const matchItems = Array.isArray(d.items) && d.items.some(item => item.name?.toLowerCase().includes(needle));
      return matchMerchant || matchCategory || matchSubCategory || matchItems;
    });
  }

  if (minAmount != null) {
    filtered = filtered.filter(d => d.total != null && d.total >= minAmount);
  }

  if (maxAmount != null) {
    filtered = filtered.filter(d => d.total != null && d.total <= maxAmount);
  }

  // Sort by createdAt descending
  filtered.sort((a, b) => {
    const timeA = a.createdAt?.toDate?.()?.getTime() || 0;
    const timeB = b.createdAt?.toDate?.()?.getTime() || 0;
    return timeB - timeA;
  });

  return filtered.slice(0, limit).map(d => ({
    merchant:  d.merchant,
    total:     d.total,
    category:  d.category,
    subCategory: d.subCategory,
    date:      d.date,
    items:     d.items || [],
    createdAt: d.createdAt?.toDate?.()?.toISOString?.() ?? null,
    currency:  d.currency,
  }));
}

const { setBudget, getBudgetReport } = require('./budget');

function getDefaultUser() {
  const raw = process.env.ALLOWED_PHONES || '';
  const firstPhone = raw.split(',')[0]?.trim();
  return firstPhone || '+14165551234';
}

async function executeTool(name, args) {
  const from = getDefaultUser();
  switch (name) {
    case 'getSpendingTotal':      return getSpendingTotal(args);
    case 'getSpendingByCategory': return getSpendingByCategory(args);
    case 'getTopMerchants':       return getTopMerchants(args);
    case 'getRecentReceipts':     return getRecentReceipts(args);
    case 'getMonthlySummary':     return getMonthlySummary(args);
    case 'searchReceipts':        return searchReceipts(args);
    case 'setCategoryBudget':     return setBudget(from, args.category, args.limit);
    case 'getBudgetStatus':       return getBudgetReport(from);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOL_DECLARATIONS, executeTool };

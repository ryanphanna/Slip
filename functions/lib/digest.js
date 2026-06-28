const admin = require('firebase-admin');
const { aggregateSpendingByCategory, getLastMonthStats } = require('./query');
const { getAllBudgets } = require('./budget');
const { sendSms } = require('./twilio');

async function sendMonthlyDigest(from) {
  const stats = await getLastMonthStats(from);
  if (stats.count === 0) return;

  const breakdown = Object.entries(stats.categories)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `${cat}: $${amt.toFixed(2)}`)
    .join('\n');

  const receiptWord = stats.count === 1 ? 'receipt' : 'receipts';
  await sendSms(from, `${stats.month} recap: $${stats.total.toFixed(2)} across ${stats.count} ${receiptWord}\n\n${breakdown}`);
}

async function sendWeeklyBudgetCheck(from) {
  const budgets = await getAllBudgets(from);
  if (budgets.length === 0) return;

  const db = admin.firestore();
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const snapshot = await db.collection('receipts')
    .where('from', '==', from)
    .where('createdAt', '>=', startOfMonth)
    .get();

  const docs = snapshot.docs.map(doc => doc.data());
  const { categories: spentMap } = aggregateSpendingByCategory(docs);

  const lines = budgets
    .map(b => {
      const spentKey = Object.keys(spentMap).find(k => k.toLowerCase() === b.category.toLowerCase());
      const spent = spentKey ? spentMap[spentKey] : 0;
      const pct = b.limit > 0 ? Math.round((spent / b.limit) * 100) : 0;
      const flag = spent > b.limit ? '⚠️ ' : pct >= 80 ? '🔶 ' : '';
      return { line: `${flag}${b.category}: $${spent.toFixed(2)} / $${b.limit.toFixed(2)} (${pct}%)`, over: spent > b.limit, near: pct >= 80 };
    })
    .sort((a, b) => (b.over ? 1 : 0) - (a.over ? 1 : 0) || (b.near ? 1 : 0) - (a.near ? 1 : 0))
    .map(r => r.line);

  const monthName = now.toLocaleString('en-CA', { month: 'long' });
  await sendSms(from, `${monthName} budgets:\n\n${lines.join('\n')}`);
}

module.exports = { sendMonthlyDigest, sendWeeklyBudgetCheck };

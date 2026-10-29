const admin = require('firebase-admin');
const { aggregateSpendingByCategory, getLastMonthStats, currentMonthDocs } = require('./query');
const { getAllBudgets } = require('./budget');
const { getSettings } = require('./settings');
const { sendSms } = require('./twilio');
const { alsoSpentLine } = require('./money');

async function sendMonthlyDigest(from) {
  const settings = await getSettings(from);
  if (settings.monthlyDigestEnabled === false) return;
  const stats = await getLastMonthStats(from);
  if (stats.count === 0 && !stats.byCurrency) return;

  const db = admin.firestore();
  const notificationRef = db.collection('notifications').doc(`${from.replace(/\D/g, '')}_${stats.monthKey}`);
  if ((await notificationRef.get()).exists) return;

  const breakdown = Object.entries(stats.categories)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `${cat}: $${amt.toFixed(2)}`)
    .join('\n');

  const receiptWord = stats.count === 1 ? 'receipt' : 'receipts';
  const alsoSpent = alsoSpentLine(stats.byCurrency);
  const message = `${stats.month} recap: $${stats.total.toFixed(2)} across ${stats.count} ${receiptWord}${breakdown ? `\n\n${breakdown}` : ''}${alsoSpent ? `\n\n${alsoSpent}` : ''}`;
  await sendSms(from, message);
  await notificationRef.set({
    from,
    type: 'monthlyDigest',
    title: `${stats.month} recap`,
    month: stats.month,
    monthKey: stats.monthKey,
    total: stats.total,
    count: stats.count,
    categories: stats.categories,
    ...(stats.byCurrency ? { byCurrency: stats.byCurrency } : {}),
    message,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function sendWeeklyBudgetCheck(from) {
  const budgets = await getAllBudgets(from);
  if (budgets.length === 0) return;

  const now = new Date();
  const docs = await currentMonthDocs(from);
  const { categories: spentMap, byCurrency } = aggregateSpendingByCategory(docs);

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
  const alsoSpent = alsoSpentLine(byCurrency, { note: 'not counted in budgets' });
  await sendSms(from, `${monthName} budgets:\n\n${lines.join('\n')}${alsoSpent ? `\n\n${alsoSpent}` : ''}`);
}

module.exports = { sendMonthlyDigest, sendWeeklyBudgetCheck };

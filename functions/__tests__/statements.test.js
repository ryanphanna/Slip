const {
  KIND_RULES, classify, parseAmount, splitMerchant, dateInStatement,
  parseAmexCsv, parseAmexPdf, parseSimpliiChequingPdf, describeStatement, dedupeStatements,
} = require('../lib/statements');

// Made-up statements in the layouts pdftotext -layout prints. No real lines.
const AMEX_PDF = `
                American Express Cobalt Card
                Statement of Account
Prepared For                                                     Account Number                Opening Date               Closing Date
TEST PERSON                                                      XXXX XXXXX0 00000             Dec 22, 2030               Jan 21, 2031
ACCOUNT SUMMARY
       Previous Balance                                        -$100.00   Credit Limit                       $1,000.00
Less Payments                                                   $50.00    Available Credit Limit (*)           $500.00
Less Other Credits (incl. $ moved to instl.)                   $300.00    Available Cash Limit                 $100.00
Plus   Interest                                                  $0.00
Plus   Purchases                                              $1,236.84
Plus   Fees (incl. installment fees)                             $12.99
Plus   Credit Advances                                            $0.00
Plus   Other Charges                                             -$5.00
Plus   Monthly Installments (excl. fees)                       $100.00
Equals New Balance                                             $896.83
Your Transactions
Transaction    Posting       Details                                                         Amount ($)
Date           Date
New Payments
Jan 10         Jan 10        PAYMENT RECEIVED - THANK YOU                                      -50.00
                             Reference TESTREF0001
Total of Payment Activity                                                                      -50.00
New Plan It Installment Plans Created by TEST PERSON
Jan 2          Jan 2         INSTALLMENT PLAN FOR $300.00                                      300.00
                             0.00% MTHLY. FEE, 3 MOS.
Total Amount Moved to Plan It Installment Program for TEST PERSON                             300.00
Plan It Installment Program Monthly Fees
Jan 21         Jan 21        MONTHLY INSTALLMENT FEE                                             2.00
Total of Plan It Installment Program Monthly Fees                                               2.00
New Transactions for TEST PERSON
Dec 23         Dec 24        PRETEND GROCER 12            TORONTO                               40.00
Dec 30         Dec 31        MADE UP AIRWAYS              FT WORTH                           1,200.00
                             ROUTING: FROM: NOWHERE
Jan 5          Jan 6         FAKE DINER                   SAN FRANCISCO                         -13.16
                             UNITED STATES DOLLAR 10.00 @ 1.31600
               Cobalt Card
               Statement of Account
                                                                                          Page 4 / 9
Your Transactions
Transaction    Posting   Details                                                     Amount ($)
Date           Date
Jan 8          Jan 9      PRESTO MOBL           TORONTO                                    10.00
Total of New Transactions for                                                           1,236.84
TEST PERSON
Other Account Transactions
Jan 2          Jan 2      INSTALLMENT PLAN FOR $300.00                                 -300.00
Jan 3          Jan 4      SAMPLE STREAM ADY                                              -5.00
                          SampleOffer
Jan 21         Jan 21     MEMBERSHIP FEE INSTALLMENT                                     12.99
Total of Other Account Transactions                                                     -292.01
About Your Credit Limit
`;

const CHEQUING_PDF = `
                                                                 your no fee chequing account
                                                                            statement period:       December 28, 2030 - January 27, 2031
details
trans.       eff.           transaction                                                   funds out           funds in          balance
date         date
Dec 28       Dec 28         BALANCE FORWARD                                                                                       100.00
Dec 30       Dec 29         Medallion-000Test                                              1,000.00                               900.00-
Jan 02       Jan 02         PRETENDCO123456 PAYROLL                                                           1,500.00           600.00
                                                        transactions continue in the next page
trans.       eff.           transaction                                                   funds out           funds in          balance
Jan 03       Jan 03         INTERAC E-TRANSFER SEND Pat                                       20.00                               580.00
Jan 27       Jan 27         INTEREST                                                                               0.02           580.02
                                                                       end of transactions
total funds out                                                                            1,020.00
total funds in                                                                                                1,500.02
closing balance                                                                                                                   580.02
`;

describe('parseAmount', () => {
  test.each([
    ['1,234.56', 1234.56], ['-1,234.56', -1234.56], ['-$206.00', -206], ['$12.99', 12.99], ['134.91-', -134.91],
  ])('%s', (text, value) => expect(parseAmount(text)).toBe(value));
});

describe('dateInStatement', () => {
  test('December lines on a January statement land in the year before', () => {
    expect(dateInStatement('Dec', 23, '2031-01-21')).toBe('2030-12-23');
    expect(dateInStatement('Jan', 5, '2031-01-21')).toBe('2031-01-05');
  });
});

describe('splitMerchant', () => {
  test('takes the place after the last run of spaces', () => {
    expect(splitMerchant('PRETEND GROCER 12            TORONTO')).toEqual({ merchant: 'PRETEND GROCER 12', location: 'TORONTO' });
  });
  test('leaves single-spaced text whole', () => {
    expect(splitMerchant('MADE UP RAIL INC. MONTREAL')).toEqual({ merchant: 'MADE UP RAIL INC. MONTREAL', location: '' });
  });
  test('takes a run-together city and province', () => {
    expect(splitMerchant("SAMPLE NF #0001      TORONTO    ON")).toEqual({ merchant: 'SAMPLE NF #0001', location: 'TORONTO ON' });
  });
  test('removes masked account numbers', () => {
    expect(splitMerchant('PHONECO ******1234       800-555-0100').merchant).toBe('PHONECO');
    expect(splitMerchant('PHONECO *123456789       800-555-0100').merchant).toBe('PHONECO');
    expect(splitMerchant('LANDLORD CORP 12345678 TORONTO')).toEqual({ merchant: 'LANDLORD CORP', location: 'TORONTO' });
    expect(splitMerchant('Right of offset TO AC123456789').merchant).toBe('Right of offset TO');
    expect(splitMerchant('PRETEND CAFE #1234      TORONTO').merchant).toBe('PRETEND CAFE #1234');
  });
});

describe('parseAmexPdf', () => {
  const result = parseAmexPdf(AMEX_PDF, { sourceFile: 'test' });

  test('reconciles against the printed totals', () => {
    expect(result.reconciliation).toEqual({ ok: true, problems: [] });
    expect(result.account).toBe('Amex Cobalt');
    expect(result.period).toEqual({ from: '2030-12-22', to: '2031-01-21' });
  });

  test('reads every line across a page break, leaving out the plan record', () => {
    expect(result.transactions.map((t) => t.description)).toEqual([
      'PAYMENT RECEIVED - THANK YOU', 'MONTHLY INSTALLMENT FEE', 'PRETEND GROCER 12 TORONTO',
      'MADE UP AIRWAYS FT WORTH', 'FAKE DINER SAN FRANCISCO', 'PRESTO MOBL TORONTO',
      'INSTALLMENT PLAN FOR $300.00', 'SAMPLE STREAM ADY', 'MEMBERSHIP FEE INSTALLMENT',
    ]);
  });

  test('fills dates, reference, foreign amount and kind', () => {
    const [payment, fee, grocer, , diner, presto, plan, offer, membership] = result.transactions;
    expect(payment).toMatchObject({ amount: -50, kind: 'card-payment', ref: 'TESTREF0001', date: '2031-01-10' });
    expect(fee.kind).toBe('fee');
    expect(grocer).toMatchObject({ date: '2030-12-23', postedDate: '2030-12-24', merchant: 'PRETEND GROCER 12', location: 'TORONTO', kind: 'purchase' });
    expect(diner).toMatchObject({ amount: -13.16, foreignAmount: -10, foreignCurrency: 'USD', kind: 'refund' });
    expect(presto.kind).toBe('reload');
    expect(plan.kind).toBe('transfer');
    expect(offer.kind).toBe('refund');
    expect(membership.kind).toBe('fee');
  });

  test('marks a statement whose lines do not add up', () => {
    const broken = parseAmexPdf(AMEX_PDF.replace('-50.00\n                             Reference', '-60.00\n                             Reference'));
    expect(broken.reconciliation.ok).toBe(false);
    expect(broken.reconciliation.problems.join(' ')).toMatch(/payments/);
  });
});

describe('parseSimpliiChequingPdf', () => {
  const result = parseSimpliiChequingPdf(CHEQUING_PDF, { sourceFile: 'test' });

  test('reconciles totals and the running balance', () => {
    expect(result.reconciliation).toEqual({ ok: true, problems: [] });
    expect(result.opening).toBe(100);
    expect(result.closing).toBe(580.02);
  });

  test('takes signs from the running balance and the date from the effective date', () => {
    expect(result.transactions.map((t) => [t.date, t.postedDate, t.amount, t.kind])).toEqual([
      ['2030-12-29', '2030-12-30', 1000, 'rent'],
      ['2031-01-02', '2031-01-02', -1500, 'income'],
      ['2031-01-03', '2031-01-03', 20, 'etransfer-person'],
      ['2031-01-27', '2031-01-27', -0.02, 'interest'],
    ]);
  });

  test('flags a row that breaks the running balance', () => {
    const broken = parseSimpliiChequingPdf(CHEQUING_PDF.replace('20.00                               580.00', '25.00                               580.00'));
    expect(broken.reconciliation.ok).toBe(false);
    expect(broken.reconciliation.problems.join(' ')).toMatch(/running balance/);
  });
});

describe('parseAmexCsv', () => {
  const csv = [
    'Date,Date Processed,Description,Amount,Foreign Spend Amount,Commission,Exchange Rate,Additional Information,Merchant,Address,City / Province,Postal Code,Country,Reference',
    '03 Feb 2031,04 Feb 2031,PRETEND CAFE           TORONTO,4.50,,,,,PRETEND CAFE           TORONTO,1 FAKE ST,"TORONTO\nON",A1A 1A1,CANADA,\'TESTREF0002\'',
    '05 Feb 2031,05 Feb 2031,SAMPLE APP  SAN FRANCISCO,13.50,10.00 USD,,1.35,,SAMPLE APP  SAN FRANCISCO,,,,,\'TESTREF0003\'',
    '06 Feb 2031,06 Feb 2031,PAYMENT RECEIVED - THANK YOU,-100.00,,,,,,,,,,\'TESTREF0004\'',
  ].join('\n');

  test('reads dates, merchant column, foreign amount, reference and kind', () => {
    const rows = parseAmexCsv(csv, { account: 'Amex Cobalt', sourceFile: 'test' });
    expect(rows[0]).toMatchObject({ date: '2031-02-03', postedDate: '2031-02-04', merchant: 'PRETEND CAFE', location: 'TORONTO ON, CANADA', amount: 4.5, ref: 'TESTREF0002', kind: 'purchase' });
    expect(rows[1]).toMatchObject({ foreignAmount: 10, foreignCurrency: 'USD' });
    expect(rows[2]).toMatchObject({ amount: -100, kind: 'card-payment' });
  });
});

describe('classify', () => {
  const kind = (description, amount, type) => classify({ description, amount }, type);
  test.each([
    ['PAYMENT THANK YOU/PAIEMENT MERCI', -50, 'card', 'card-payment'],
    ['American Express', 500, 'bank', 'card-payment'],
    ['VISA, CIBC/BANQUE CIBC', 80, 'bank', 'card-payment'],
    ['VISA SIMPLII FINANCIAL', 80, 'bank', 'card-payment'],
    ['EFT REVERSAL AMEX BANK OF CANA', -80, 'bank', 'card-payment'],
    ['Wealthsimple Investments Inc.', 200, 'bank', 'transfer'],
    ['TRANSFER IN', -200, 'bank', 'transfer'],
    ['PRETEND CO PAYROLL', -2000, 'bank', 'income'],
    ['CANADA LIFE', -90, 'bank', 'income'],
    ['Paiement fédéral/Federal Pmt', -60, 'bank', 'income'],
    ['INTEREST', -0.05, 'bank', 'interest'],
    ['OVERLIMIT FEE', 29, 'card', 'fee'],
    ['NSF S/C', 45, 'bank', 'fee'],
    ['ABM WITHDRAWAL', 60, 'bank', 'cash'],
    ['INTERAC E-TRANSFER SEND Pat', 20, 'bank', 'etransfer-person'],
    ['Medallion-000Test', 1000, 'bank', 'rent'],
    ['TORONTO HYDRO', 40, 'bank', 'bill'],
    ['NSLSC', 10, 'bank', 'bill'],
    ['KOODO MOBILE PAC', 50, 'card', 'bill'],
    ['STARBUCKS 800-782-72 800-782-7282', 75, 'card', 'reload'],
    ['PRETEND GROCER', 12, 'card', 'purchase'],
    ['PRETEND GROCER', -12, 'card', 'refund'],
    ['PRETEND GROCER', 12, 'bank', 'unknown'],
  ])('%s (%s, %s) is %s', (description, amount, type, expected) => {
    expect(kind(description, amount, type)).toBe(expected);
  });

  test('every rule names a kind from the list', () => {
    const kinds = ['purchase', 'refund', 'card-payment', 'transfer', 'income', 'interest', 'fee', 'cash', 'etransfer-person', 'rent', 'bill', 'reload', 'unknown'];
    KIND_RULES.forEach((rule) => expect(kinds).toContain(rule.kind));
  });
});

describe('describeStatement', () => {
  test('names formats only listed in the inventory', () => {
    expect(describeStatement('Royal Bank of Canada\nFrom January 11, 2031 to February 10, 2031\nNo activity for this period'))
      .toEqual({ format: 'rbc-chequing-pdf', label: 'RBC chequing', period: { from: '2031-01-11', to: '2031-02-10' }, noActivity: true });
    expect(describeStatement('Simplii Financial Cash Back Visa* Card\nDecember 4 to January 3, 2031').period)
      .toEqual({ from: '2030-12-04', to: '2031-01-03' });
    expect(describeStatement('¢£¤ ÀÁ Ððñò àá').format).toBe('unreadable-pdf');
  });
});

describe('dedupeStatements', () => {
  const tx = (date, amount, description, ref = null) => ({ account: 'Amex Cobalt', date, amount, description, ref });

  test('keeps two identical lines in one statement and drops the copy in another', () => {
    const coffee = () => [tx('2031-01-05', 3, 'PRETEND CAFE'), tx('2031-01-05', 3, 'PRETEND CAFE')];
    const { transactions, dropped } = dedupeStatements([
      { kind: 'pdf', account: 'Amex Cobalt', month: '2031-01', transactions: coffee() },
      { kind: 'pdf', account: 'Amex Cobalt', month: '2031-01', transactions: [...coffee(), tx('2031-01-06', 3, 'PRETEND CAFE')] },
    ]);
    expect(transactions).toHaveLength(3);
    expect(dropped.duplicateLines).toBe(2);
  });

  test('a month with a CSV takes the CSV over the PDF', () => {
    const { transactions, dropped } = dedupeStatements([
      { kind: 'pdf', account: 'Amex Cobalt', month: '2031-01', transactions: [tx('2031-01-05', 3, 'PRETEND CAFE TORONTO')] },
      { kind: 'csv', account: 'Amex Cobalt', month: '2031-01', transactions: [tx('2031-01-05', 3, 'PRETEND CAFE  TORONTO', 'R1')] },
    ]);
    expect(transactions).toEqual([tx('2031-01-05', 3, 'PRETEND CAFE  TORONTO', 'R1')]);
    expect(dropped.coveredByCsv).toBe(1);
  });

  test('matches on the reference when there is one', () => {
    const { transactions } = dedupeStatements([
      { kind: 'csv', account: 'Amex Cobalt', month: '2031-01', transactions: [tx('2031-01-05', 3, 'A', 'R1')] },
      { kind: 'csv', account: 'Amex Cobalt', month: '2031-02', transactions: [tx('2031-01-06', 3, 'B', 'R1')] },
    ]);
    expect(transactions).toHaveLength(1);
  });
});

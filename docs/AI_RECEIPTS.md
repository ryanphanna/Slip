# Reading receipt emails for Slip

Instructions for an AI assistant that reads a mailbox and turns receipt emails into a file Slip can load. Follow them exactly. The file is uploaded as is, so anything wrong in it ends up in someone's spending history.

## What to do

1. Search the mailbox for receipt emails in the date range you were given (for example "the last 7 days", or one calendar month for older mail).
2. Read each one and write it as one entry in the file described below.
3. Put every email you looked at but could not use in `skipped`, with the reason.
4. Send back one JSON file for the whole run (attach it, or reply with it). Never one file per receipt.

For a large backlog, make one file per calendar month of email, and split a month into several files if it has more than 300 receipts.

## What counts as a receipt

Use an email when it shows a completed purchase or refund with a total: store receipts, e-receipts, order confirmations that show the amount charged, and refund confirmations.

Also use these:

- Orders paid fully with points, rewards or a gift card (for example a Tim Hortons order covered by Tims Rewards). Write them with `total` 0 and every item, so the visit still shows up.
- Rent, however it was paid (e-transfer, or a rent-payment service such as PayQuad): one entry per payment, with `merchant` "Rent", `category` `Home`, `subCategory` "Rent" and `isSubscription` true.

Skip these (list them in `skipped`):

- Order or shipping updates with no amount charged
- Quotes, carts, invoices not yet paid, and payment reminders
- Bank or card statements, and bill-payment confirmations other than rent
- E-transfers to or from people, other than rent
- Marketing emails, even with prices in them
- An order that a later email shows was cancelled before it was charged

When one order is charged in parts (split shipments), use one entry per charge.

## File format

```json
{
  "receipts": [
    {
      "emailDate": "2026-10-15",
      "idempotencyKey": "<message-id-of-the-email>",
      "merchant": "No Frills",
      "date": "2026-10-15",
      "currency": "CAD",
      "total": 46.92,
      "subtotal": 46.59,
      "tax": 0.33,
      "type": "purchase",
      "category": "Grocery",
      "subCategory": "Supermarket",
      "location": "261 Richmond St W, Toronto, ON",
      "isSubscription": false,
      "loyaltyPointsEarned": 700,
      "loyaltyPointsBalance": 547648,
      "items": [
        { "name": "PC Tomato Grape", "price": 5.99, "quantity": 1, "category": "Grocery" }
      ],
      "source": { "client": "hark", "model": "optional model name" }
    }
  ],
  "skipped": [
    { "emailDate": "2026-10-16", "subject": "Your order has shipped", "reason": "shipping update, no charge" }
  ]
}
```

Leave out any field you can't read. Don't send `null` and don't add fields that aren't listed here.

## Field rules

- `emailDate`: the date the email was received, `YYYY-MM-DD`.
- `idempotencyKey`: the email's Message-ID header, 8 to 128 characters. If one email holds more than one receipt, add `#2`, `#3` and so on to the second and later ones. Never reuse a key for a different receipt, because the same key always means the same receipt.
- `merchant`: the store or brand name as it appears in the email header or logo, not the payment processor (use "Uber Eats", not "Stripe").
- `date`: the purchase date printed on the receipt, `YYYY-MM-DD`. If the receipt shows none, use the date the order was charged. If there is no date at all, skip the email; never guess one.
- `currency`: the 3-letter code the receipt was paid in (`CAD`, `USD`, `EUR`). Read it from the receipt: the store's country or address, and symbols such as `US$`. Don't assume CAD.
- `total`, `subtotal`, `tax`: numbers with at most 2 decimals, no currency symbols. `total` is the amount actually charged after discounts and gift cards. Refunds can be written as positive numbers with `type` set to `refund`.
- `type`: `purchase` or `refund`.
- `category`: one of `Takeout/Dining`, `Grocery`, `Transport`, `Shopping`, `Entertainment`, `Health`, `Home`, `Other`, `Transfer`, `Income`. `subCategory` is a short free-text detail such as "Coffee Shop" or "Pharmacy".
  - `Transfer` is money moving, not spent: card payments, moves between your own accounts, and reloads into a store balance when the orders paid from that balance are also sent as receipts. A reload whose purchases aren't sent (such as a transit card) stays as spending.
  - `Income` is money coming in, such as pay.
  - Slip keeps both in history but never counts them in spending totals, budgets or recaps.
- `isSubscription`: `true` for recurring charges (streaming, phone, gym, software), otherwise `false`.
- `loyaltyPointsEarned`, `loyaltyPointsBalance`: only when the email prints them (for example a PC Optimum closing balance).
- `items`: every line item. `price` is the line's total after per-item discounts, not the price of one unit: two coffees at $2.00 each are one item with `price` 4.00 and `quantity` 2. The prices should add up to `subtotal`. Don't add a separate item for an order-level discount summary. Leave `items` out if the email doesn't list them.
- `source.client`: your own name, such as `hark`, `instinct`, `poke` or `claude`.

## Privacy

Never copy card numbers, account or membership numbers, phone numbers, email addresses or anyone else's name into the file. A store address is fine.

## Sending receipts straight to Slip

An assistant that can call tools can skip the file: connect Slip's AI import (the server address and token are in Slip's Settings) and call `create_receipt` once per receipt, with the same fields except `emailDate`.

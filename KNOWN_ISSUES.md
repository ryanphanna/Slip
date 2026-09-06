# Known Issues

Documented parsing edge cases and known limitations.

---

## IKEA Proportional Discount Receipts

**What happens:** When IKEA runs a storewide promo (e.g. "$35 off $120"), the discount is applied proportionally to each eligible item as an inline sub-line on the receipt. At the bottom, a summary coupon line shows the total discount (e.g. `$35 off $120  -35.00`).

Gemini correctly captures the post-discount net price for each item, but also captures the bottom summary line as an additional `−$35.00` line item — double-counting the discount at the line-item level. The total and subtotal fields are unaffected and remain correct.

**Impact:** Line item prices are accurate. The item list contains a spurious `Coupon $35 off $120  −$35.00` entry that makes the items sum to less than the subtotal. Total spend tracking is not affected.

**Workaround:** None currently. Manually delete the coupon line item if precise per-item breakdown matters on an affected receipt.

**Fix (2026-06-27):** Added a "Discounts" rule to the Gemini prompt (`functions/lib/gemini.js`) telling it not to add a bottom-of-receipt discount summary as a line item when per-item prices already reflect the discount. Verified 2026-09-05: both known bad receipts predate this fix (2025-08-28), and all 6 IKEA receipts parsed since have clean item lists with no recurrence.

---

## Year Misread as 2 Years Earlier (6 read as 4)

**What happens:** Two independently confirmed receipts (Indigo, No Frills) had their year misread by exactly 2 years — a clearly-printed "2026" was extracted as "2024". Both receipts printed the correct year in plain numerals, more than once in one case, so this isn't a token-order ambiguity (see date parsing guidance already in the prompt) — Gemini just misread the digit.

**Impact:** Affected receipts sort and filter as if 2 years older than they actually are. Confirmed on 2 of 6 total 2024-dated receipts in the database as of 2026-09-03 (the other 4 have no receipt image — imported order history, not OCR'd, so not at risk of this).

**Workaround:** Manually correct the date on the receipt's edit screen if you spot one.

**Fix (2026-09-03):** Added explicit guidance to the Gemini prompt (`functions/lib/gemini.js`) to read the year digit by digit, flagged 6/4 as an easily-confused pair, and to cross-check the date against itself when it's printed more than once on the same receipt. Not yet verified against a real recurrence — revisit if this keeps happening.

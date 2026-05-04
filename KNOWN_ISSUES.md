# Known Issues

Documented parsing edge cases and known limitations.

---

## IKEA Proportional Discount Receipts

**What happens:** When IKEA runs a storewide promo (e.g. "$35 off $120"), the discount is applied proportionally to each eligible item as an inline sub-line on the receipt. At the bottom, a summary coupon line shows the total discount (e.g. `$35 off $120  -35.00`).

Gemini correctly captures the post-discount net price for each item, but also captures the bottom summary line as an additional `−$35.00` line item — double-counting the discount at the line-item level. The total and subtotal fields are unaffected and remain correct.

**Impact:** Line item prices are accurate. The item list contains a spurious `Coupon $35 off $120  −$35.00` entry that makes the items sum to less than the subtotal. Total spend tracking is not affected.

**Workaround:** None currently. Manually delete the coupon line item if precise per-item breakdown matters.

**Fix:** Update the Gemini prompt to not add a coupon summary as a line item when per-item discounts are already reflected in individual prices. Requires careful prompt engineering to distinguish inline per-item discounts from standalone coupons applied at checkout.

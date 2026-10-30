const { validateReceipt, dateLooksWrong, totalsLookWrong, itemsLookMissing } = require('./validate');
const { findDuplicate, findPossibleDuplicate } = require('./store');

// The checks every new receipt goes through, whichever way it arrives (text
// message, retry from Notifications, AI import), so a fix lands everywhere at
// once (CIV-1132). The Target import keeps its own audit flow.

// A reader's result (or an import payload) as a clean receipt.
function readReceipt(raw) {
  const receipt = validateReceipt(raw);
  if (raw.confidence != null) receipt.confidence = raw.confidence;
  return receipt;
}

// "Check this" marks. `fromPhotos`: only a photo read with no items is
// suspicious; pasted texts and AI imports often have none.
function checkFlags(receipt, { receivedAt = new Date(), fromPhotos = false } = {}) {
  return {
    ...(receipt.date == null || dateLooksWrong(receipt.date, receivedAt) ? { dateNeedsCheck: true } : {}),
    ...(totalsLookWrong(receipt) ? { totalsNeedCheck: true } : {}),
    ...(fromPhotos && itemsLookMissing(receipt) ? { itemsNeedCheck: true } : {}),
  };
}

// Resend check, possible-duplicate check and check marks. Returns
// { duplicateId } for a resend that must not be saved, otherwise { flags }
// to save with the receipt. `skipResendCheck`: a retry is the user asking
// again on purpose.
async function checkReceipt(receipt, from, { receivedAt, fromPhotos, messageSid, messagePart, skipResendCheck = false } = {}) {
  if (!skipResendCheck) {
    const duplicateId = await findDuplicate(receipt, from, { messageSid, messagePart });
    if (duplicateId) return { duplicateId };
  }
  const possibleDuplicateOf = await findPossibleDuplicate(receipt, from);
  return {
    duplicateId: null,
    flags: {
      ...checkFlags(receipt, { receivedAt, fromPhotos }),
      ...(possibleDuplicateOf ? { possibleDuplicate: true, possibleDuplicateOf } : {}),
    },
  };
}

// Plain-language notes for the flags, for the text-message reply. The
// missing-items mark stays quiet (CIV-432).
function flagNotes(receipt, flags) {
  return [
    ...(flags.possibleDuplicate ? ['Possible duplicate of an earlier receipt.'] : []),
    ...(flags.dateNeedsCheck && receipt.date ? [`Check the date: ${receipt.date} looks wrong.`] : []),
    ...(flags.totalsNeedCheck ? ['Check the amounts: the items, tax and total don\'t add up.'] : []),
  ];
}

// Every "check this" mark a saved receipt can carry, including the
// statement-import mark (CIV-1194). The web app can clear these, never set them.
const CHECK_FIELDS = [
  'possibleDuplicate', 'possibleDuplicateOf', 'dateNeedsCheck', 'totalsNeedCheck',
  'currencyNeedsCheck', 'itemsNeedCheck', 'statementReview',
];

// True when a receipt still has a mark to look at.
function isFlagged(receipt) {
  return Boolean(receipt.possibleDuplicate || receipt.dateNeedsCheck || receipt.totalsNeedCheck
    || receipt.currencyNeedsCheck || receipt.itemsNeedCheck || receipt.statementReview);
}

module.exports = { readReceipt, checkFlags, checkReceipt, flagNotes, CHECK_FIELDS, isFlagged };

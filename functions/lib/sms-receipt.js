const logger = require('firebase-functions/logger');
const { sendSms, fetchMedia } = require('./twilio');
const { parseReceiptFromBase64, parseReceiptFromText, groupReceiptPhotos, photoReadNothing } = require('./receipt');
const { saveReceipt, saveProcessingFailure } = require('./store');
const { getLastReceipt, aggregateSpendingByCategory, currentMonthDocs } = require('./query');
const { saveImages, saveFailedImages } = require('./image-store');
const { getBudget } = require('./budget');
const { formatMoney, currencyOf, DEFAULT_CURRENCY } = require('./money');
const { readReceipt, checkReceipt, flagNotes } = require('./receipt-checks');
const config = require('./config');

const oops = () => config.ERROR_OPENERS[Math.floor(Math.random() * config.ERROR_OPENERS.length)];

// Reads a receipt text message (pasted text or photos), saves the receipt(s)
// and texts back the result. Runs after Twilio has been answered; a failure
// is recorded so it can be retried from Notifications.
function processReceiptMessage({ body, from, maskedFrom, messageSid, numMedia }) {
    const images = [];
    let storedImagePaths = [];
    let receiptSaved = false; // once true, later failures must not create a retryable failure row
    return (async () => {
      let isFirstReceipt = false;
      try {
        const lastReceipt = await getLastReceipt(from);
        isFirstReceipt = !lastReceipt;
      } catch (dbErr) {
        logger.error('Failed to query last receipt for first receipt check', { messageSid, error: dbErr.message });
      }

      let raw;
      let photoGroups = [];
      if (numMedia === 0) {
        const bodyText = (body.Body || '').trim();
        if (!bodyText) {
          await sendSms(from, 'Send me a photo or paste text of a receipt to log it.');
          return;
        }

        if (bodyText.length > config.MAX_BODY_TEXT_LENGTH) {
          await sendSms(from, `${oops()} That's a lot of text! Try pasting just the key lines from the receipt.`);
          return;
        }

        raw = await parseReceiptFromText(bodyText, isFirstReceipt);

        const extractedNothing = raw.merchant == null && raw.total == null &&
          (!Array.isArray(raw.items) || raw.items.length === 0);
        if (extractedNothing) {
          logger.info('Text message did not look like a receipt, skipping save', { messageSid });
          await sendSms(from, "That didn't look like a receipt. Send INFO for commands.");
          return;
        }
      } else {
        const mediaPromises = [];
        for (let i = 0; i < numMedia; i++) {
          const mimeType = body[`MediaContentType${i}`] || 'image/jpeg';
          const mediaUrl = body[`MediaUrl${i}`];
          if (config.ALLOWED_IMAGE_TYPES.includes(mimeType.toLowerCase()) && mediaUrl) {
            mediaPromises.push((async () => {
              const imgResponse = await fetchMedia(mediaUrl);
              const contentLength = Number.parseInt(imgResponse.headers.get('content-length') || '0', 10);
              if (contentLength > config.MAX_IMAGE_SIZE) return null;

              const buffer = Buffer.from(await imgResponse.arrayBuffer());
              if (buffer.length > config.MAX_IMAGE_SIZE) return null;

              return { buffer, mimeType };
            })());
          }
        }

        const fetchedMedia = (await Promise.all(mediaPromises)).filter(Boolean);
        let totalMediaBytes = 0;
        for (const item of fetchedMedia) {
          if (totalMediaBytes + item.buffer.length <= config.MAX_TOTAL_MEDIA_SIZE) {
            totalMediaBytes += item.buffer.length;
            images.push({ base64: item.buffer.toString('base64'), mimeType: item.mimeType });
          }
        }

        if (images.length === 0) {
          await sendSms(from, `${oops()} I couldn't read that photo. Try sending a clearer image, one receipt at a time.`);
          return;
        }

        // Photos in one text can be one long receipt or several receipts.
        photoGroups = await groupReceiptPhotos(images);
        if (photoGroups.length === 1) {
          raw = await parseReceiptFromBase64(images, undefined, isFirstReceipt);
          if (photoReadNothing(raw)) throw new Error('Nothing could be read from the photos');
        }
      }

      // Saves one read receipt and returns its reply text. `part` numbers the
      // receipts of a text that held several (null for a single receipt).
      async function saveParsedReceipt(raw, receiptImages, part) {
        const receipt = readReceipt(raw);

        // Store images and run the checks in parallel to optimize latency
        const [imagePaths, { duplicateId, flags }] = await Promise.all([
          receiptImages.length > 0
            ? saveImages(receiptImages, messageSid, receipt).catch(err => {
                logger.error('Image storage failed (non-fatal)', { messageSid, error: err.message });
                return [];
              })
            : Promise.resolve([]),
          checkReceipt(receipt, from, { fromPhotos: receiptImages.length > 0, messageSid, messagePart: part }),
        ]);

        storedImagePaths = imagePaths;
        if (duplicateId) {
          logger.info('Duplicate receipt detected, skipping save', { messageSid, from: maskedFrom, duplicateId });
          return `Duplicate: ${receipt.merchant} — ${formatMoney(Math.abs(receipt.total), currencyOf(receipt))} was already logged.`;
        }

        await saveReceipt(receipt, from, messageSid, imagePaths, {
          ...flags,
          ...(part != null ? { messagePart: part } : {}),
        });
        receiptSaved = true;

        const merchant = receipt.merchant || 'Unknown';
        const receiptCurrency = currencyOf(receipt);
        const total = receipt.total != null ? formatMoney(Math.abs(receipt.total), receiptCurrency) : '?';
        const categoryDisplay = receipt.subCategory ? `${receipt.category}: ${receipt.subCategory}` : receipt.category;
        const prefix = receipt.type === 'refund' ? 'Saved Refund' : 'Saved';
        const itemCount = Array.isArray(receipt.items) ? receipt.items.length : 0;
        const itemSuffix = itemCount === 1 ? '1 item' : `${itemCount} items`;

        let message = `${prefix}: ${merchant} — ${total} (${categoryDisplay}, ${itemSuffix})`;
        for (const note of flagNotes(receipt, flags)) message += `\n${note}`;

        if (raw.confidence != null && raw.confidence < 0.7) {
          message = `⚠️ ${message}`;
          logger.warn('Low confidence receipt saved', { messageSid, confidence: raw.confidence, merchant });
        }

        const marks = Object.keys(flags).filter((key) => key.endsWith('NeedsCheck'));
        if (marks.length > 0) logger.warn('Receipt saved marked for checking', { messageSid, merchant, marks, date: receipt.date });

        if (!receipt.date) {
          message += '\n\nCouldn\'t find a date on this one — re-send if it matters.';
          logger.warn('Receipt saved with no date', { messageSid, merchant });
        }

        // Budgets are CAD limits, so a non-CAD receipt gets no budget status.
        if (receipt.category && receiptCurrency === DEFAULT_CURRENCY) {
          try {
            const budget = await getBudget(from, receipt.category);
            if (budget && budget.limit > 0) {
              const docs = await currentMonthDocs(from);
              const { categories } = aggregateSpendingByCategory(docs);
              const spentKey = Object.keys(categories).find(k => k.toLowerCase() === receipt.category.toLowerCase());
              const spent = spentKey ? categories[spentKey] : 0;

              const remaining = Math.round((budget.limit - spent) * 100) / 100;
              const budgetLine = `\nBudget: $${spent.toFixed(2)}/$${budget.limit.toFixed(2)} spent`;

              if (spent > budget.limit) {
                message += `${budgetLine} (⚠️ over by $${Math.abs(remaining).toFixed(2)})`;
              } else {
                message += `${budgetLine} ($${remaining.toFixed(2)} left)`;
              }
            }
          } catch (budgetErr) {
            logger.error('Failed to append budget status to receipt confirmation', { messageSid, error: budgetErr.message });
          }
        }

        logger.info('Successfully processed receipt', { messageSid, from: maskedFrom, merchant, total, part, confidence: raw.confidence });
        return message;
      }

      let message;
      if (photoGroups.length <= 1) {
        message = await saveParsedReceipt(raw, images, null);
      } else {
        const replies = [];
        for (const [part, indexes] of photoGroups.entries()) {
          const groupImages = indexes.map((index) => ({ ...images[index], index }));
          const label = `Receipt ${part + 1} of ${photoGroups.length}`;
          receiptSaved = false; // tracks this part only until the loop ends
          try {
            const partRaw = await parseReceiptFromBase64(groupImages, undefined, isFirstReceipt);
            if (photoReadNothing(partRaw)) throw new Error('Nothing could be read from the photos');
            const reply = await saveParsedReceipt(partRaw, groupImages, part);
            replies.push(`${label}: ${reply}`);
          } catch (partErr) {
            logger.error('Receipt in a multi-receipt text failed', { messageSid, part, error: partErr.message });
            if (receiptSaved) continue;
            let failureImagePaths = [];
            try {
              failureImagePaths = await saveFailedImages(groupImages, messageSid);
            } catch (storageErr) {
              logger.error('Failed to preserve images for processing failure', { messageSid, part, error: storageErr.message });
            }
            try {
              await saveProcessingFailure({ from, messageSid, messagePart: part, error: partErr.message, imagePaths: failureImagePaths, numMedia: groupImages.length });
            } catch (failureErr) {
              logger.error('Failed to save processing failure record', { messageSid, part, error: failureErr.message });
            }
            replies.push(`${label}: couldn't read it. It's in Notifications to retry.`);
          }
        }
        // Every part is saved or recorded, so a later error must not record the whole text again.
        receiptSaved = true;
        message = `${photoGroups.length} receipts in that message.\n\n${replies.join('\n\n')}`;
      }

      if (isFirstReceipt) {
        message += '\n\n💡 Tip: Send TOTAL to see your monthly spend, or INFO for all commands.';
      }

      await sendSms(from, message);
    })().catch(async (err) => {
      logger.error('Receipt processing failed', {
        messageSid,
        from: maskedFrom,
        error: err && err.message ? err.message : err,
        cause: err && err.cause && err.cause.message ? err.cause.message : undefined,
        receiptSaved,
      });

      // The receipt is already stored; this was a later step (reply SMS, budget text...).
      // Recording a failure would offer a Retry that creates a duplicate, and telling
      // the user it failed would be wrong.
      if (receiptSaved) return;

      let failureImagePaths = storedImagePaths;
      if (images.length > 0 && failureImagePaths.length === 0) {
        try {
          failureImagePaths = await saveFailedImages(images, messageSid);
        } catch (storageErr) {
          logger.error('Failed to preserve images for processing failure', { messageSid, error: storageErr.message });
        }
      }

      try {
        await saveProcessingFailure({
          from,
          messageSid,
          error: err && err.message ? err.message : String(err),
          imagePaths: failureImagePaths,
          numMedia,
          sourceText: numMedia === 0 ? (body.Body || '').trim() : undefined,
        });
      } catch (failureErr) {
        logger.error('Failed to save processing failure record', { messageSid, error: failureErr.message });
      }

      try {
        const lastReceipt = await getLastReceipt(from);
        if (!lastReceipt) {
          await sendSms(from, config.ONBOARDING_MESSAGE);
          return;
        }
      } catch (dbErr) {
        logger.error('Failed to query last receipt for onboarding check', { messageSid, error: dbErr.message });
      }

      await Promise.resolve(sendSms(from, `${oops()} Couldn't read that receipt. Try again with a clearer image or shorter text.`)).catch(() => {});
    });
}

module.exports = { processReceiptMessage };

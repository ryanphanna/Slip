function readConfigValue(envName, secretParam) {
  const envValue = process.env[envName];
  if (envValue) return { value: envValue, source: 'env' };

  if (secretParam) {
    try {
      const secretValue = secretParam.value();
      if (secretValue) return { value: secretValue, source: 'secret' };
    } catch (_) {
      // Secret access can fail in tests or before the runtime mounts secrets.
    }
  }

  return { value: '', source: 'missing' };
}

function getAllowedPhoneCount(raw) {
  if (!raw) return 0;
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .length;
}

function maskWebhookHost(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch (_) {
    return 'invalid';
  }
}

function summarizeRuntimeHealth({
  twilioAccountSid,
  twilioAuthToken,
  twilioPhoneNumber,
  geminiApiKey,
  allowedPhones,
  webhookUrl,
} = {}) {
  const accountSid = readConfigValue('TWILIO_ACCOUNT_SID', twilioAccountSid);
  const authToken = readConfigValue('TWILIO_AUTH_TOKEN', twilioAuthToken);
  const phoneNumber = readConfigValue('TWILIO_PHONE_NUMBER', twilioPhoneNumber);
  const geminiKey = readConfigValue('GEMINI_API_KEY', geminiApiKey);
  const allowlist = readConfigValue('ALLOWED_PHONES', allowedPhones);
  const webhook = readConfigValue('WEBHOOK_URL', webhookUrl);

  return {
    projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'unknown',
    service: process.env.K_SERVICE || process.env.FUNCTION_TARGET || 'unknown',
    revision: process.env.K_REVISION || 'unknown',
    nodeVersion: process.version,
    hasTwilioAccountSid: Boolean(accountSid.value),
    hasTwilioAuthToken: Boolean(authToken.value),
    hasTwilioPhoneNumber: Boolean(phoneNumber.value),
    hasGeminiApiKey: Boolean(geminiKey.value),
    allowedPhoneCount: getAllowedPhoneCount(allowlist.value),
    allowedPhonesSource: allowlist.source,
    hasWebhookUrl: Boolean(webhook.value),
    webhookUrlSource: webhook.source,
    webhookHost: maskWebhookHost(webhook.value),
  };
}

module.exports = { summarizeRuntimeHealth, readConfigValue, getAllowedPhoneCount, maskWebhookHost };

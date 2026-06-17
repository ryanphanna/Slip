#!/usr/bin/env node
/**
 * Ask questions about your spending in natural language.
 * Usage: node scripts/ask.js "how much did I spend last month?"
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeAdminApp } = require('../lib/admin');
const { TOOL_DECLARATIONS, executeTool } = require('../lib/spending-tools');

initializeAdminApp();

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function getSecret(name) {
  const version = process.env.SMOKE_SECRET_VERSION || '1';
  try {
    return execFileSync('firebase', ['functions:secrets:access', `${name}@${version}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) { return ''; }
}

function getConfig(name) {
  return process.env[name] || getSecret(name) || '';
}

async function ask(question) {
  const apiKey = getConfig('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    systemInstruction: `You are a personal spending assistant for a receipt-tracking app called Slip.
The user has logged receipts via MMS. Answer spending questions concisely using the available tools.
Amounts are in the receipt's original currency (usually CAD). Be direct and use numbers.
Today's date is ${new Date().toISOString().slice(0, 10)}.
When the user says "last month", "this year", etc., compute the exact dates yourself and pass them to the tools.`,
  });

  const chat = model.startChat();
  let response = await chat.sendMessage(question);

  // Agentic loop: keep calling tools until Gemini gives a text response
  while (true) {
    const parts = response.response.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = parts.filter(p => p.functionCall);

    if (toolCalls.length === 0) {
      return response.response.text();
    }

    const toolResults = await Promise.all(
      toolCalls.map(async part => {
        const { name, args } = part.functionCall;
        try {
          const result = await executeTool(name, args);
          return { functionResponse: { name, response: { result } } };
        } catch (err) {
          return { functionResponse: { name, response: { error: err.message } } };
        }
      })
    );

    response = await chat.sendMessage(toolResults);
  }
}

async function main() {
  loadDotenv(path.join(__dirname, '..', '.env'));

  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('Usage: node scripts/ask.js "your question here"');
    process.exit(1);
  }

  try {
    const answer = await ask(question);
    console.log(answer);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();

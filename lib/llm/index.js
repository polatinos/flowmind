'use strict';

const anthropic = require('./anthropic');
const openai = require('./openai');
const gemini = require('./gemini');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { TOOL_DEFINITIONS } = require('../tools');

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    run: anthropic.runConversation,
    defaultModel: anthropic.DEFAULT_MODEL,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
    needsBaseUrl: false,
  },
  openai: {
    label: 'OpenAI (GPT)',
    run: openai.runConversation,
    defaultModel: openai.DEFAULT_MODEL,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    needsBaseUrl: false,
  },
  gemini: {
    label: 'Google Gemini',
    run: gemini.runConversation,
    defaultModel: gemini.DEFAULT_MODEL,
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    needsBaseUrl: false,
  },
  compatible: {
    // OpenAI-compatible endpoint: Ollama, Groq, LM Studio, vLLM, or Google's
    // OpenAI-compatible Gemini endpoint. Requires a base URL + model.
    label: 'OpenAI-compatibel (Ollama/Groq/lokaal)',
    run: openai.runConversation,
    defaultModel: '',
    models: [],
    needsBaseUrl: true,
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    defaultModel: p.defaultModel,
    models: p.models,
    needsBaseUrl: Boolean(p.needsBaseUrl),
  }));
}

/**
 * Run one assistant turn against the selected provider's tool-use loop.
 *
 * @param {object} p
 * @param {string} p.provider          'anthropic' | 'openai' | 'gemini' | 'compatible'
 * @param {string} p.apiKey
 * @param {string} [p.model]
 * @param {string} [p.baseUrl]         required for the 'compatible' provider
 * @param {Array<{role,content}>} p.messages
 * @param {HomeyContext} p.homeyContext
 * @param {(msg)=>void} [p.log]
 * @returns {Promise<{ reply, steps, provider, model }>}
 */
async function runAssistant({ provider, apiKey, model, baseUrl, messages, homeyContext, log }) {
  const chosen = PROVIDERS[provider];
  if (!chosen) throw new Error(`Unknown provider: ${provider}`);
  if (chosen.needsBaseUrl && !baseUrl) {
    throw new Error(`The ${provider} provider needs a base URL (e.g. http://<homey-ip>:11434/v1).`);
  }
  if (!apiKey && !chosen.needsBaseUrl) {
    throw new Error(`No API key configured for ${provider}.`);
  }

  const usedModel = model || chosen.defaultModel;
  const { reply, steps } = await chosen.run({
    apiKey,
    model: usedModel,
    baseUrl,
    system: SYSTEM_PROMPT,
    messages,
    tools: TOOL_DEFINITIONS,
    executeTool: (name, input) => homeyContext.executeTool(name, input),
    maxSteps: 10,
    log,
  });

  return { reply, steps, provider, model: usedModel };
}

module.exports = { runAssistant, listProviders, PROVIDERS };

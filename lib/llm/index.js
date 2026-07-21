'use strict';

const anthropic = require('./anthropic');
const openai = require('./openai');
const gemini = require('./gemini');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { TOOL_DEFINITIONS } = require('../tools');

const PROVIDERS = {
  zen: {
    // OpenCode Zen — the easy, free option (like the Home Assistant "opencode"
    // add-on). OpenAI-compatible, so it reuses the OpenAI tool-use path with a
    // fixed base URL. Free "Big Pickle" model by default; the free models
    // currently work even without an API key (key: opencode.ai/auth).
    // NB: the Zen API wants bare model ids ("big-pickle"), NOT "opencode/…".
    label: 'OpenCode Zen (gratis · Big Pickle)',
    run: openai.runConversation,
    defaultModel: 'big-pickle',
    models: ['big-pickle', 'deepseek-v4-flash-free', 'nemotron-3-ultra-free', 'mimo-v2.5-free'],
    fixedBaseUrl: 'https://opencode.ai/zen/v1',
    needsBaseUrl: false,
    keyOptional: true,
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    run: anthropic.runConversation,
    defaultModel: anthropic.DEFAULT_MODEL,
    models: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'],
    needsBaseUrl: false,
  },
  openai: {
    label: 'OpenAI (GPT)',
    run: openai.runConversation,
    defaultModel: openai.DEFAULT_MODEL,
    models: ['gpt-5.1', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini'],
    needsBaseUrl: false,
  },
  gemini: {
    label: 'Google Gemini',
    run: gemini.runConversation,
    defaultModel: gemini.DEFAULT_MODEL,
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
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
    keyOptional: Boolean(p.keyOptional),
    fixedBaseUrl: p.fixedBaseUrl || null,
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
async function runAssistant({ provider, apiKey, model, baseUrl, messages, homeyContext, log, maxSteps = 10 }) {
  const chosen = PROVIDERS[provider];
  if (!chosen) throw new Error(`Unknown provider: ${provider}`);
  if (chosen.needsBaseUrl && !baseUrl) {
    throw new Error(`The ${provider} provider needs a base URL (e.g. http://<homey-ip>:11434/v1).`);
  }
  if (!apiKey && !chosen.needsBaseUrl && !chosen.keyOptional) {
    throw new Error(`No API key configured for ${provider}.`);
  }

  const effectiveBaseUrl = chosen.fixedBaseUrl || baseUrl;
  const usedModel = model || chosen.defaultModel;

  // Inject the persistent memories into the system prompt for this turn.
  let system = SYSTEM_PROMPT;
  try {
    const memories = homeyContext.getMemoriesText();
    if (memories) system += `\n\n## Saved memories\n${memories}`;
  } catch (err) {
    // Memory is a nice-to-have; never block a chat turn on it.
  }

  const { reply, steps } = await chosen.run({
    apiKey,
    model: usedModel,
    baseUrl: effectiveBaseUrl,
    system,
    messages,
    tools: TOOL_DEFINITIONS,
    executeTool: (name, input) => homeyContext.executeTool(name, input),
    maxSteps,
    log,
  });

  return { reply, steps, provider, model: usedModel };
}

module.exports = { runAssistant, listProviders, PROVIDERS };

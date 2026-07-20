'use strict';

const anthropic = require('./anthropic');
const openai = require('./openai');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { TOOL_DEFINITIONS } = require('../tools');

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    run: anthropic.runConversation,
    defaultModel: anthropic.DEFAULT_MODEL,
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
  },
  openai: {
    label: 'OpenAI (GPT)',
    run: openai.runConversation,
    defaultModel: openai.DEFAULT_MODEL,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    defaultModel: p.defaultModel,
    models: p.models,
  }));
}

/**
 * Run one assistant turn: takes the neutral chat history, drives the selected
 * provider's tool-use loop against the Homey tools, and returns the reply.
 *
 * @param {object} p
 * @param {string} p.provider          'anthropic' | 'openai'
 * @param {string} p.apiKey
 * @param {string} [p.model]
 * @param {Array<{role,content}>} p.messages
 * @param {HomeyContext} p.homeyContext
 * @param {(msg)=>void} [p.log]
 * @returns {Promise<{ reply, steps, provider, model }>}
 */
async function runAssistant({ provider, apiKey, model, messages, homeyContext, log }) {
  const chosen = PROVIDERS[provider];
  if (!chosen) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) throw new Error(`No API key configured for ${provider}.`);

  const usedModel = model || chosen.defaultModel;
  const { reply, steps } = await chosen.run({
    apiKey,
    model: usedModel,
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

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
    // Labels are shown as-is in both languages, so keep them to brand names:
    // the UI already appends the localised free/paid tag and the model name.
    label: 'OpenCode Zen',
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
    label: 'OpenAI-compatible (Ollama/Groq)',
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
 * @param {(step)=>void} [p.onStep]  live progress: { tool, status: 'running'|'ok'|'error', error? }
 * @returns {Promise<{ reply, steps, provider, model }>}
 */
async function runAssistant({
  provider, apiKey, model, baseUrl, messages, homeyContext, log, onStep, maxSteps = 10,
  // Free models (Zen) hand out HTTP 429 regularly. A chat turn already runs as
  // a background job, so waiting out a short rate limit is better than losing
  // the turn; a flow card has no such room and passes { attempts: 0 }.
  retry = { attempts: 2, maxWaitMs: 30000 },
}) {
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

  // Say up front whether flows can be written at all. Without this the model
  // only finds out by calling a flow tool, so it would happily spend a whole
  // conversation designing a flow it can never save — asking which lamps to
  // use and which webhook name to pick, then failing at the last step.
  try {
    const flowWrite = await homeyContext.getFlowWriteStatus();
    if (!flowWrite.canWrite) {
      // Flatten and cap the error: it is a connection message about the
      // Homey's own LAN address, but it lands in the system prompt, and a
      // multi-line body would break up the block (or worse, add headings).
      const why = String(flowWrite.error || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      system += `\n\n## RIGHT NOW: you cannot create, change or delete flows
${flowWrite.keySet
    ? `The saved Homey API key is not working${why ? ` (${why})` : ''}.`
    : 'No Homey API key is set in the FlowMind settings.'}
Reading flows and controlling devices still work normally; only writing flows is blocked.
If the user asks for anything that would create, change or delete a flow: say so in your FIRST reply, in one or two sentences, and explain the fix (${flowWrite.keySet
    ? 'check the key in the FlowMind settings, or make a new one at my.homey.app -> Settings -> System -> API keys'
    : 'create a key at my.homey.app -> Settings -> System -> API keys and paste it into the FlowMind settings under "Homey API key"'}).
Do NOT start designing the flow, do NOT ask follow-up questions about lamps, names or webhooks, and do NOT call a flow-writing tool to "see what happens". Offer to build it as soon as the key is in place. If the user explicitly wants to continue planning anyway, you may — but only after you have said this once.`;
    }
  } catch (err) {
    // Status is an extra: a chat turn must never fail because of it.
  }

  const { reply, steps } = await chosen.run({
    apiKey,
    model: usedModel,
    baseUrl: effectiveBaseUrl,
    system,
    messages,
    tools: TOOL_DEFINITIONS,
    retry: {
      ...retry,
      // One shared waiting budget for the whole turn. Per-request caps alone
      // let a turn with many tool steps stack 30s waits until the settings
      // page gives up at five minutes and throws the answer away.
      budget: { remainingMs: Number.isFinite(retry.budgetMs) ? retry.budgetMs : 60000 },
      // Surface the wait in the live action log, so a pause does not read as
      // a hung app.
      onRetry: ({ waitMs }) => {
        const seconds = Math.round(waitMs / 1000);
        if (log) log(`[rate limit] waiting ${seconds}s before retrying`);
        if (onStep) {
          try {
            onStep({ tool: 'rate_limit_wait', status: 'running', waitSeconds: seconds });
          } catch (err) { /* ignore */ }
        }
      },
      onRetryDone: ({ waitMs }) => {
        if (onStep) {
          try {
            onStep({
              tool: 'rate_limit_wait',
              status: 'ok',
              waitSeconds: Math.round(waitMs / 1000),
            });
          } catch (err) { /* ignore */ }
        }
      },
    },
    // Log failing tools: without this a broken tool is invisible in the app
    // log, and the only trace is the steps panel in the settings page.
    executeTool: async (name, input) => {
      // Live progress for the settings page; a broken listener must never
      // break the turn itself.
      if (onStep) try { onStep({ tool: name, status: 'running' }); } catch (err) { /* ignore */ }
      const result = await homeyContext.executeTool(name, input);
      if (result && result.error && log) log(`[tool] ${name} failed: ${result.error}`);
      if (onStep) {
        const failed = Boolean(result && result.error);
        try {
          onStep({
            tool: name,
            status: failed ? 'error' : 'ok',
            ...(failed ? { error: String(result.error).slice(0, 200) } : {}),
          });
        } catch (err) { /* ignore */ }
      }
      return result;
    },
    maxSteps,
    log,
  });

  return { reply, steps, provider, model: usedModel };
}

module.exports = { runAssistant, listProviders, PROVIDERS };

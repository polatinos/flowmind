'use strict';

const { requestJson } = require('../http');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';
// Current models think before answering and that counts toward max_tokens,
// so 4096 could cut a turn off mid tool call.
const DEFAULT_MAX_TOKENS = 16000;
// Models whose safety classifiers can decline a request. With
// `fallbacks: "default"` the API re-runs a declined request on a suitable
// model itself, instead of returning a refusal. Other models reject the field.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Convert the neutral tool definitions to Anthropic's `tools` format.
 * Anthropic already uses { name, description, input_schema }, so this is a pass-through.
 */
function toAnthropicTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema || { type: 'object', properties: {} },
  }));
}

/**
 * Run a full agentic conversation with tool-use against the Anthropic Messages API.
 *
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} [p.model]
 * @param {string} p.system                 system prompt
 * @param {Array<{role,content}>} p.messages neutral chat history (text turns)
 * @param {Array} p.tools                    neutral tool definitions
 * @param {(name, input) => Promise<any>} p.executeTool
 * @param {number} [p.maxSteps=8]
 * @param {(msg)=>void} [p.log]
 * @returns {Promise<{ reply: string, steps: Array }>}
 */
async function runConversation({
  apiKey,
  model,
  system,
  messages,
  tools,
  executeTool,
  maxSteps = 8,
  log = () => {},
}) {
  const anthropicTools = toAnthropicTools(tools);
  // Anthropic messages use content arrays; seed from the neutral text history.
  // The API requires strictly alternating user/assistant roles, but the chat
  // history can contain consecutive user turns (e.g. after a failed request),
  // so merge consecutive same-role messages into one.
  const convo = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = convo[convo.length - 1];
    if (last && last.role === role) {
      last.content.push({ type: 'text', text: String(m.content) });
    } else {
      convo.push({ role, content: [{ type: 'text', text: String(m.content) }] });
    }
  }

  const steps = [];
  let finalText = '';

  const useModel = model || DEFAULT_MODEL;
  const withFallback = FALLBACK_MODELS.has(useModel);
  const headers = { 'x-api-key': apiKey, 'anthropic-version': API_VERSION };
  if (withFallback) headers['anthropic-beta'] = FALLBACK_BETA;

  for (let i = 0; i < maxSteps; i += 1) {
    const body = {
      model: useModel,
      max_tokens: DEFAULT_MAX_TOKENS,
      // System prompt + tools are identical on every step of the tool loop;
      // caching them makes each step after the first far cheaper.
      cache_control: { type: 'ephemeral' },
      system,
      tools: anthropicTools,
      messages: convo,
    };
    if (withFallback) body.fallbacks = 'default';
    const response = await requestJson(ENDPOINT, { method: 'POST', headers, body });

    // Non-streaming, so a fallback never leaves a declined partial in
    // `content`: the assistant turn can be echoed back verbatim below.
    const content = Array.isArray(response.content) ? response.content : [];
    const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text);
    if (textBlocks.length) finalText = textBlocks.join('\n').trim();

    if (response.stop_reason === 'refusal') {
      const why = response.stop_details && response.stop_details.explanation;
      return {
        reply: finalText || `The model declined this request${why ? `: ${why}` : '.'} Try rephrasing it.`,
        steps,
      };
    }

    const toolUses = content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { reply: finalText, steps };
    }

    // Record the assistant turn (with its tool_use blocks) verbatim.
    convo.push({ role: 'assistant', content });

    // Execute every requested tool and feed results back.
    const toolResults = [];
    for (const tu of toolUses) {
      log(`[anthropic] tool_use ${tu.name}`);
      const result = await executeTool(tu.name, tu.input || {});
      steps.push({ tool: tu.name, input: tu.input || {}, result });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    convo.push({ role: 'user', content: toolResults });
  }

  return {
    reply:
      finalText ||
      'I reached the maximum number of tool steps before finishing. Please refine your request.',
    steps,
  };
}

module.exports = { runConversation, DEFAULT_MODEL };

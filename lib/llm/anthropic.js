'use strict';

const { requestJson } = require('../http');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;

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
  const convo = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: String(m.content) }],
  }));

  const steps = [];
  let finalText = '';

  for (let i = 0; i < maxSteps; i += 1) {
    const response = await requestJson(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: {
        model: model || DEFAULT_MODEL,
        max_tokens: DEFAULT_MAX_TOKENS,
        system,
        tools: anthropicTools,
        messages: convo,
      },
    });

    const content = Array.isArray(response.content) ? response.content : [];
    const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text);
    if (textBlocks.length) finalText = textBlocks.join('\n').trim();

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

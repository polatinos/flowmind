'use strict';

const { requestJson } = require('../http');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';

// Build the chat-completions endpoint from a base URL. Works for OpenAI itself
// and for any OpenAI-compatible server (Ollama, Groq, LM Studio, Google's
// OpenAI-compatible Gemini endpoint, …). Trailing slashes and an accidental
// "/chat/completions" suffix are tolerated.
function chatEndpoint(baseUrl) {
  let base = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

/**
 * Convert the neutral tool definitions to OpenAI's function-calling format:
 *   { type: 'function', function: { name, description, parameters } }
 */
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * Run a full agentic conversation with tool-use against the OpenAI Chat
 * Completions API. Same interface & return shape as the Anthropic provider,
 * so the caller does not care which LLM is used (normalised tool-use).
 */
async function runConversation({
  apiKey,
  model,
  baseUrl,
  system,
  messages,
  tools,
  executeTool,
  maxSteps = 8,
  log = () => {},
  retry,
}) {
  const endpoint = chatEndpoint(baseUrl);
  const openAITools = toOpenAITools(tools);
  const convo = [
    { role: 'system', content: system },
    ...messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content),
    })),
  ];

  const steps = [];
  let finalText = '';

  for (let i = 0; i < maxSteps; i += 1) {
    const response = await requestJson(endpoint, {
      method: 'POST',
      retry,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: {
        model: model || DEFAULT_MODEL,
        messages: convo,
        tools: openAITools,
        tool_choice: 'auto',
      },
    });

    const choice = (response.choices && response.choices[0]) || {};
    const message = choice.message || {};
    if (message.content) finalText = String(message.content).trim();

    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      return { reply: finalText, steps };
    }

    // Echo the assistant message (with tool_calls) back into the conversation.
    convo.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const name = call.function && call.function.name;
      let input = {};
      try {
        input = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        input = {};
      }
      log(`[openai] tool_call ${name}`);
      const result = await executeTool(name, input);
      steps.push({ tool: name, input, result });
      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply:
      finalText ||
      'I reached the maximum number of tool steps before finishing. Please refine your request.',
    steps,
  };
}

module.exports = { runConversation, DEFAULT_MODEL, DEFAULT_BASE_URL };

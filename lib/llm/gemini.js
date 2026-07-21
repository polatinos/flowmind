'use strict';

const { requestJson } = require('../http');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';

/**
 * Gemini accepts an OpenAPI-subset schema for function parameters. Strip the
 * JSON-Schema keywords it rejects and drop empty parameter objects (Gemini
 * wants `parameters` omitted for no-arg functions).
 */
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  const clean = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      clean.properties = {};
      for (const [pk, pv] of Object.entries(v)) clean.properties[pk] = sanitizeSchema(pv);
    } else if (k === 'items') {
      clean.items = sanitizeSchema(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

function toGeminiTools(tools) {
  return [
    {
      functionDeclarations: tools.map((t) => {
        const params = sanitizeSchema(t.input_schema);
        const hasProps = params && params.properties && Object.keys(params.properties).length > 0;
        return {
          name: t.name,
          description: t.description,
          ...(hasProps ? { parameters: params } : {}),
        };
      }),
    },
  ];
}

/**
 * Run a full tool-use conversation against the Gemini generateContent REST API.
 * Same interface & return shape as the other providers (normalised tool-use).
 *
 * The generativelanguage endpoint uses roles "user" and "model"; function
 * results are sent back as a "user" turn containing functionResponse parts.
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
  const usedModel = model || DEFAULT_MODEL;
  const url = `${BASE}/${encodeURIComponent(usedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const geminiTools = toGeminiTools(tools);

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content) }],
  }));

  const steps = [];
  let finalText = '';

  for (let i = 0; i < maxSteps; i += 1) {
    const response = await requestJson(url, {
      method: 'POST',
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: geminiTools,
      },
    });

    const candidate = (response.candidates && response.candidates[0]) || {};
    const parts = (candidate.content && candidate.content.parts) || [];

    const textParts = parts.filter((p) => typeof p.text === 'string').map((p) => p.text);
    if (textParts.length) finalText = textParts.join('\n').trim();

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      return { reply: finalText, steps };
    }

    // Echo the model's function-call turn back into the history.
    contents.push({ role: 'model', parts });

    const responseParts = [];
    for (const call of calls) {
      log(`[gemini] functionCall ${call.name}`);
      const result = await executeTool(call.name, call.args || {});
      steps.push({ tool: call.name, input: call.args || {}, result });
      responseParts.push({
        functionResponse: {
          name: call.name,
          // Gemini requires the response to be a JSON object.
          response: result && typeof result === 'object' && !Array.isArray(result)
            ? result
            : { result },
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return {
    reply:
      finalText ||
      'I reached the maximum number of tool steps before finishing. Please refine your request.',
    steps,
  };
}

module.exports = { runConversation, DEFAULT_MODEL };

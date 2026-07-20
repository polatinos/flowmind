'use strict';

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_KEYS = ['outputSuccess', 'outputError', 'outputTrue', 'outputFalse'];

/**
 * Advanced-flow cards must be keyed by UUIDs and reference each other by UUID.
 * To make life easy for the LLM we let it use readable keys ("trigger1",
 * "cond1", ...) and remap every key + every reference to a fresh UUID here.
 *
 * References live in:
 *   - the connection arrays (outputSuccess / outputError / outputTrue / outputFalse)
 *   - the `input` array of `all` / `any` join nodes, as "<key>::outputName"
 *
 * @param {Object<string, object>} cards
 * @returns {Object<string, object>} cards re-keyed by UUID with references fixed
 */
function normalizeAdvancedFlowCards(cards) {
  const keys = Object.keys(cards || {});
  const idMap = {};
  for (const key of keys) {
    idMap[key] = UUID_RE.test(key) ? key : crypto.randomUUID();
  }
  const remapKey = (k) => (Object.prototype.hasOwnProperty.call(idMap, k) ? idMap[k] : k);

  const out = {};
  for (const key of keys) {
    const card = { ...cards[key] };
    for (const outKey of OUTPUT_KEYS) {
      if (Array.isArray(card[outKey])) card[outKey] = card[outKey].map(remapKey);
    }
    if (Array.isArray(card.input)) {
      card.input = card.input.map((ref) => {
        const [refKey, port] = String(ref).split('::');
        return `${remapKey(refKey)}${port ? `::${port}` : ''}`;
      });
    }
    out[idMap[key]] = card;
  }
  return out;
}

module.exports = { normalizeAdvancedFlowCards, UUID_RE };

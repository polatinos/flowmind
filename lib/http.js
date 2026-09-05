'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Minimal dependency-free JSON HTTP(S) client.
 *
 * Homey Pro's app sandbox does not guarantee a global `fetch`, so we use the
 * built-in `http`/`https` modules. Plain http:// is needed for local
 * OpenAI-compatible servers such as Ollama (http://<ip>:11434/v1).
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='POST']
 * @param {object} [opts.headers]
 * @param {object} [opts.body]        JSON-serialisable request body
 * @param {number} [opts.timeout=120000]
 * @returns {Promise<any>} parsed JSON response
 */
function requestOnce(url, opts = {}) {
  const {
    method = 'POST',
    headers = {},
    body = null,
    timeout = 120000,
  } = opts;

  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }

    const data = body != null ? JSON.stringify(body) : null;
    const requestHeaders = { ...headers };
    if (data != null) {
      requestHeaders['Content-Type'] = requestHeaders['Content-Type'] || 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(data);
    }

    const isHttp = parsedUrl.protocol === 'http:';
    const transport = isHttp ? http : https;
    const req = transport.request(
      {
        method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttp ? 80 : 443),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: requestHeaders,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (err) {
            parsed = { raw };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const message =
              (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
              (parsed && parsed.message) ||
              (typeof parsed.raw === 'string' ? parsed.raw : JSON.stringify(parsed));
            const error = new Error(
              `HTTP ${res.statusCode}: ${String(message).slice(0, 800)}`,
            );
            error.statusCode = res.statusCode;
            error.body = parsed;
            error.retryAfter = res.headers['retry-after'] || null;
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request to ${parsedUrl.hostname} timed out after ${timeout}ms`));
    });

    if (data != null) req.write(data);
    req.end();
  });
}

const DEFAULT_RETRY_WAIT_MS = 5000;

/**
 * How long to wait before retrying a rate-limited request.
 *
 * Providers state the delay in three different places: a Retry-After header
 * (seconds), or somewhere in the error text as "[30s]" / "try again in 12
 * seconds". Read whichever is present, otherwise fall back to a short wait.
 */
function rateLimitWaitMs(error) {
  const fromHeader = Number(error && error.retryAfter);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader * 1000;

  const text = error && error.message ? String(error.message) : '';
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)/i);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return DEFAULT_RETRY_WAIT_MS;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JSON request that survives a rate limit.
 *
 * The free OpenCode Zen models hand out HTTP 429 regularly, and without this
 * the whole chat turn died on it — the user saw "Rate limit exceeded" and had
 * to retype their message. Waiting the advertised handful of seconds inside
 * the background job is invisible to them.
 *
 * Only 429 is retried: other errors are the caller's problem and a failed
 * write must never be repeated blindly.
 *
 * @param {object} [opts.retry]
 * @param {number} [opts.retry.attempts=2]    extra attempts after the first
 * @param {number} [opts.retry.maxWaitMs=30000]  give up if this one wait is longer
 * @param {{remainingMs:number}} [opts.retry.budget]  waiting time shared across
 *   every request in one assistant turn, so a turn cannot creep past the
 *   settings page's five-minute deadline one 30s wait at a time
 * @param {(info)=>void} [opts.retry.onRetry]
 * @param {(info)=>void} [opts.retry.onRetryDone]
 */
async function requestJson(url, opts = {}) {
  const { retry = {}, ...rest } = opts;
  const attempts = Number.isInteger(retry.attempts) ? retry.attempts : 2;
  const maxWaitMs = Number.isFinite(retry.maxWaitMs) ? retry.maxWaitMs : 30000;
  const budget = retry.budget && Number.isFinite(retry.budget.remainingMs)
    ? retry.budget
    : null;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce(url, rest);
    } catch (err) {
      const isLast = attempt >= attempts;
      if (err.statusCode !== 429 || isLast) throw err;

      const waitMs = rateLimitWaitMs(err);
      // A wait longer than the budget helps nobody: the settings page is
      // polling and a flow card has an even tighter deadline.
      if (waitMs > maxWaitMs) throw err;
      if (budget && waitMs > budget.remainingMs) throw err;

      const notify = (fn) => {
        if (typeof fn !== 'function') return;
        try {
          fn({ attempt: attempt + 1, waitMs });
        } catch (cbErr) {
          /* a broken progress listener must never break the request */
        }
      };
      notify(retry.onRetry);
      await sleep(waitMs);
      if (budget) budget.remainingMs -= waitMs;
      // Close the progress line off, or the live log shows the wait as a step
      // that never finishes.
      notify(retry.onRetryDone);
    }
  }
}

module.exports = { requestJson, rateLimitWaitMs };

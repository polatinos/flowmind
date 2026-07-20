'use strict';

const https = require('https');
const { URL } = require('url');

/**
 * Minimal dependency-free JSON HTTP client.
 *
 * Homey Pro's app sandbox does not guarantee a global `fetch`, so we use the
 * built-in `https` module. This keeps the app installable with `homey app run`
 * without pulling in extra runtime dependencies for the LLM calls.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='POST']
 * @param {object} [opts.headers]
 * @param {object} [opts.body]        JSON-serialisable request body
 * @param {number} [opts.timeout=120000]
 * @returns {Promise<any>} parsed JSON response
 */
function requestJson(url, opts = {}) {
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

    const req = https.request(
      {
        method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
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

module.exports = { requestJson };

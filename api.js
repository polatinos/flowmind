'use strict';

/**
 * Web API endpoints for the app settings page (chat UI).
 * Route names/paths are declared in app.json under "api"; the handlers here
 * must match those names. `homey.app` is the HomeyAIApp instance from app.js.
 */
module.exports = {
  async getConfig({ homey }) {
    return homey.app.getConfig();
  },

  async saveConfig({ homey, body }) {
    return homey.app.saveConfig(body || {});
  },

  async chat({ homey, body }) {
    return homey.app.chat(body || {});
  },
};

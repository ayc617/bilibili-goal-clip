/* GoalClip bounded local result cache. MIT; see ../LICENSE. */
(function (root) {
  'use strict';
  const VERSION = 'goal-analysis-1-prompt-1';
  const PREFIX = 'goal_result_';
  const TTL = 7 * 86400000;
  const MAX_BYTES = 1800000;
  async function keyFor(snapshot, goal, model = 'deepseek-v4-flash') {
    const raw = JSON.stringify([VERSION, model, snapshot.video, snapshot.transcriptHash, goal.trim()]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return PREFIX + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  function createCache(storage, now = Date.now) {
    return {
      async get(key) {
        const entry = (await storage.get(key))[key];
        if (!entry) return { response: null, invalidated: false };
        if (entry.version !== VERSION || !Number.isFinite(entry.savedAt) || now() - entry.savedAt > TTL || !entry.response) {
          await storage.remove(key); return { response: null, invalidated: true };
        }
        return { response: entry.response, invalidated: false };
      },
      async remove(key) { await storage.remove(key); },
      async set(key, response) {
        const entry = { version: VERSION, savedAt: now(), response };
        if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > MAX_BYTES / 2) return false;
        const all = await storage.get(null);
        const entries = Object.entries(all).filter(([k]) => k.startsWith(PREFIX) && k !== key)
          .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
        let bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
        const remove = [];
        entries.forEach(([k, value], i) => {
          bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (i >= 19 || bytes > MAX_BYTES || now() - value.savedAt > TTL) remove.push(k);
        });
        if (remove.length) await storage.remove(remove);
        await storage.set({ [key]: entry });
        return true;
      },
    };
  }
  const api = { VERSION, PREFIX, TTL, keyFor, createCache };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalCache = api;
})(globalThis);

/* Bounded UI/draft metadata only; analysis evidence stays in GoalCache. MIT. */
(function(root) {
  'use strict';
  const PREFIX = 'goal_state_', VERSION = 1, TTL = 7 * 86400000;
  const keyFor = video => PREFIX + video.bvid + '@p' + video.page;
  function createStore(storage, now = Date.now) {
    let writes = Promise.resolve();
    const serial = task => { const result = writes.then(task); writes = result.catch(() => {}); return result; };
    return {
      drain() { return writes; },
      async get(video) {
        await writes;
        const key = keyFor(video), value = (await storage.get(key))[key];
        if (!value) return null;
        if (value.version !== VERSION || !Number.isFinite(value.savedAt) || now() - value.savedAt > TTL ||
            typeof value.draft !== 'string' || value.draft.length > 1000 ||
            value.video?.bvid !== video.bvid || value.video?.page !== video.page) {
          await storage.remove(key); return null;
        }
        return value;
      },
      save(video, entry) {
        const value = JSON.parse(JSON.stringify({ ...entry, video: { bvid: video.bvid, page: video.page }, version: VERSION, savedAt: now() }));
        if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 12000) return Promise.resolve();
        const key = keyFor(video);
        // Dispatch the small metadata write immediately, including during pagehide.
        let writing;
        try { writing = Promise.resolve(storage.set({ [key]: value })); }
        catch (failure) { writing = Promise.reject(failure); }
        writing.catch(() => {}); // A queued write is still awaited and reported by its owner.
        return serial(async () => {
          await writing;
          const all = await storage.get(null);
          const others = Object.entries(all).filter(([k]) => k.startsWith(PREFIX) && k !== key)
            .sort((a,b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
          let bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
          const remove = [];
          others.forEach(([k,v],i) => {
            bytes += new TextEncoder().encode(JSON.stringify(v)).byteLength;
            if (i >= 19 || bytes > 128000 || now() - v.savedAt > TTL) remove.push(k);
          });
          if (remove.length) await storage.remove(remove);
        });
      },
      remove(video) { return serial(() => storage.remove(keyFor(video))); },
    };
  }
  const api = { PREFIX, VERSION, TTL, keyFor, createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalSessionState = api;
})(globalThis);

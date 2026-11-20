/* GoalClip local subtitle evidence. MIT; see ../LICENSE for upstream notices. */
(function (root) {
  "use strict";
  const VERSION = 1;
  const NOTICE = "仅按词法匹配；未匹配不代表视频没有讨论该内容。";
  const normalize = (text) => text.normalize("NFKC").toLowerCase();

  function tokens(text) {
    const value = normalize(text);
    const out = value.match(/[a-z0-9]+(?:[.+#_/-][a-z0-9]+)*[+#]*/g) || [];
    // Keep Node.js/HTTP/2 intact while also supporting queries for Node/HTTP.
    for (const term of [...out]) {
      if (/[.+#_/-]/.test(term)) out.push(...(term.match(/[a-z0-9]+/g) || []));
    }
    for (const run of value.match(/[\p{Script=Han}]+/gu) || []) {
      const chars = Array.from(run);
      if (chars.length === 1) out.push(chars[0]);
      for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    }
    return out;
  }

  async function createSnapshot(input) {
    const identity = input.video || input;
    const bvid = String(identity.bvid || "");
    const cid = String(identity.cid || "");
    const page = Number(identity.page);
    if (!/^BV[A-Za-z0-9]{10}$/.test(bvid) || !/^\d+$/.test(cid) ||
        !/[1-9]/.test(cid) || !Number.isSafeInteger(page) || page < 1) {
      throw new TypeError("A valid BVID, CID and page are required");
    }
    const video = {
      bvid, cid, page,
      language: String(input.language ?? identity.language ?? "unknown"),
      sourceType: String(input.sourceType ?? identity.sourceType ?? "unknown"),
      provider: String(input.provider ?? identity.provider ?? "unknown"),
    };
    const entries = input.cues || input.transcript;
    if (!Array.isArray(entries)) throw new TypeError("Subtitle cues must be an array");
    const raw = entries.map((entry) => {
      const start = entry.start;
      const end = entry.end ?? (typeof entry.duration === "number" ? start + entry.duration : NaN);
      if (typeof entry.text !== "string" || !entry.text.trim() ||
          !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
        throw new TypeError("Each cue needs original text and finite, ordered start/end times");
      }
      return { start, end, text: entry.text };
    });
    const bytes = new TextEncoder().encode(JSON.stringify({ version: VERSION, video, cues: raw }));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const transcriptHash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const prefix = `${bvid}:${cid}:p${page}:${transcriptHash}`;
    const cues = raw.map((cue, index) => Object.freeze({ cueId: `${prefix}:c${index}`, ...cue }));
    const segments = cues.map((cue, index) => Object.freeze({
      segmentId: `${prefix}:s${index}`, cueIds: Object.freeze([cue.cueId]),
      start: cue.start, end: cue.end, text: cue.text,
    }));
    return Object.freeze({ schemaVersion: VERSION, transcriptHash,
      video: Object.freeze(video), cues: Object.freeze(cues), segments: Object.freeze(segments) });
  }

  function createIndex(snapshot) {
    if (snapshot.schemaVersion !== VERSION) throw new TypeError("Unsupported evidence version");
    const byCue = new Map(snapshot.cues.map(cue => [cue.cueId, cue]));
    const bySegment = new Map(snapshot.segments.map(segment => [segment.segmentId, segment]));
    const generatedIds = new Set();
    const documents = snapshot.segments.map(segment => {
      const terms = tokens(segment.text);
      const counts = new Map();
      terms.forEach(term => counts.set(term, (counts.get(term) || 0) + 1));
      return { segment, counts, length: terms.length };
    });
    const frequencies = new Map();
    documents.forEach(doc => doc.counts.forEach((_, term) => frequencies.set(term, (frequencies.get(term) || 0) + 1)));
    const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / (documents.length || 1) || 1;

    function getEvidence(id) {
      if (byCue.has(id)) return [byCue.get(id)];
      const segment = bySegment.get(id);
      return segment ? segment.cueIds.map(cueId => byCue.get(cueId)) : [];
    }

    function search(query, options = {}) {
      if (typeof query !== "string" || query.length > 4000) throw new TypeError("Query must be a string of at most 4000 characters");
      const limit = options.limit ?? 5;
      if (!Number.isInteger(limit) || limit < 3 || limit > 8) throw new RangeError("limit must be 3–8");
      // Only retain merged evidence for the latest search, not every past query.
      generatedIds.forEach(id => bySegment.delete(id));
      generatedIds.clear();
      const terms = [...new Set(tokens(query))];
      const scored = [];
      documents.forEach((doc, index) => {
        let score = 0;
        const matchedTerms = [];
        for (const term of terms) {
          const tf = doc.counts.get(term) || 0;
          if (!tf) continue;
          const df = frequencies.get(term);
          const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
          score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / averageLength));
          matchedTerms.push(term);
        }
        if (!score) return;
        // Prefer multi-term coverage; scores are lexical weights, not probabilities.
        score *= matchedTerms.length / terms.length;
        if (query.trim() && normalize(doc.segment.text).includes(normalize(query.trim()))) score *= 1.5;
        scored.push({ ...doc.segment, score, matchedTerms, index });
      });
      // Merge only consecutive matching cues, retaining every original boundary.
      const merged = [];
      for (const hit of scored) {
        const previous = merged[merged.length - 1];
        if (previous && hit.index === previous.lastIndex + 1 && hit.start >= previous.start &&
            hit.start - previous.end <= 3 && Math.max(hit.end, previous.end) - previous.start <= 60 &&
            previous.text.length + hit.text.length <= 800) {
          previous.cueIds.push(...hit.cueIds);
          previous.end = Math.max(previous.end, hit.end);
          previous.text += "\n" + hit.text;
          previous.score = Math.max(previous.score, hit.score);
          previous.matchedTerms = [...new Set([...previous.matchedTerms, ...hit.matchedTerms])];
          previous.lastIndex = hit.index;
          previous.segmentId = `${snapshot.transcriptHash}:m${previous.firstIndex}-${hit.index}`;
        } else merged.push({ ...hit, cueIds: [...hit.cueIds], firstIndex: hit.index, lastIndex: hit.index });
      }
      merged.sort((a, b) => b.score - a.score || a.start - b.start || a.index - b.index);
      const results = [];
      const signature = text => normalize(text).replace(/[\p{P}\p{Z}\s]/gu, "");
      const similar = (a, b) => {
        const left = signature(a), right = signature(b);
        if (left === right) return true;
        // Numeric differences can change the meaning of otherwise repetitive evidence.
        if (JSON.stringify(a.match(/\d+(?:\.\d+)?/g)) !== JSON.stringify(b.match(/\d+(?:\.\d+)?/g))) return false;
        if (Math.min(left.length, right.length) < 12) return false;
        const grams = s => new Set(Array.from(s).slice(1).map((_, i) => s.slice(i, i + 2)));
        const x = grams(left), y = grams(right);
        const shared = [...x].filter(t => y.has(t)).length;
        return shared / (x.size + y.size - shared) >= 0.9;
      };
      for (const hit of merged) {
        const { index, firstIndex, lastIndex, ...segment } = hit;
        Object.freeze(segment.cueIds);
        Object.freeze(segment.matchedTerms);
        Object.freeze(segment);
        if (!bySegment.has(segment.segmentId)) {
          bySegment.set(segment.segmentId, segment);
          generatedIds.add(segment.segmentId);
        }
        const duplicate = results.find(result => similar(result.text, segment.text));
        // Repeated wording is collapsed visually, but every independent location survives.
        if (duplicate) duplicate.occurrences.push(segment);
        else results.push({ ...segment, occurrences: [segment] });
      }
      return { query, video: snapshot.video, transcriptHash: snapshot.transcriptHash,
        status: results.length ? "matched" : "no_match", notice: NOTICE,
        results: results.slice(0, limit), totalGroups: results.length };
    }
    return Object.freeze({ getSnapshot: () => snapshot, search, getEvidence });
  }

  const api = Object.freeze({ VERSION, createSnapshot, createIndex });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GoalTranscriptIndex = api;
})(globalThis);

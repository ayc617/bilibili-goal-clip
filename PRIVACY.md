# Privacy

Bilibili Digest has no account system, analytics, telemetry, advertising, or developer-operated server.

- The extension reads public video metadata and available subtitle tracks from Bilibili.
- Your DeepSeek API key, notes, settings, and recent cache entries are stored in `chrome.storage.local`.
- When an AI feature is requested, the relevant transcript and video context are sent directly from the extension to DeepSeek.
- No API key is included in the source code or release package.

Bilibili and DeepSeek process requests under their own terms and privacy policies. Remove all local extension data from Settings before uninstalling if you do not want Chrome to retain it.

## Optional Bailian transcription

Bilibili subtitles are preferred. Only after the user confirms the audio-upload/cost disclosure and separately clicks Start Transcription does the extension download audio, upload it to Alibaba Cloud Bailian temporary storage, and call Fun-ASR using the user's own key/quota. Saving a key never starts transcription. The key is configured only at this optional entry and remains in chrome.storage.local; it is not returned to the page or logged. Transcription evidence may be cached locally with its source and original service timestamps. Closing a running dialog does not undo an already-started upload or service charge. No developer-operated backend or billing system is involved.

## Goal navigation recovery

Goal drafts, selected tab, disclosure state, scroll position and recent video/subtitle identity are saved separately in chrome.storage.local for recovery (up to 20 UI records, 7 days, approximately 128 KB total budget). AI result evidence stays in the existing bounded Goal cache. New state records never copy API keys. Clearing a video's goal removes only that video's recovery record; it does not delete other videos or re-run AI. Restoration reads subtitles and caches without calling an LLM or ASR.

/* GoalClip BYOK adapter. MIT; see ../LICENSE. Existing features stay unchanged. */
(function (root) {
  'use strict';
  const MESSAGES = {
    NO_AI_KEY: '请先配置 DeepSeek API Key。', UNAUTHORIZED: 'API Key 无效或无权限。',
    RATE_LIMITED: '服务限流，请稍后手动重试。', TIMEOUT: '目标分析请求超时。',
    EMPTY_RESPONSE: '模型返回空响应。', PROVIDER_ERROR: '模型服务请求失败。',
  };
  function createByokProvider(requestCompletion) {
    return Object.freeze({
      async complete(request) {
        try {
          const { text } = await requestCompletion({
            messages: request.messages, maxTokens: request.maxOutputTokens,
            temperature: 0.2, responseFormat: { type: 'json_object' },
          });
          if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error(), { code: 'EMPTY_AI_RESPONSE' });
          // Never propagate settings (which include the user's key), raw service errors, or credentials.
          return { text, provider: 'deepseek-byok', requestId: request.requestId,
            identity: request.identity };
        } catch (error) {
          const code = error.status === 401 ? 'UNAUTHORIZED'
            : error.status === 429 ? 'RATE_LIMITED'
            : error.code === 'NO_AI_KEY' ? 'NO_AI_KEY'
            : /TIMEOUT/.test(error.code || '') ? 'TIMEOUT'
            : error.code === 'EMPTY_AI_RESPONSE' ? 'EMPTY_RESPONSE' : 'PROVIDER_ERROR';
          throw Object.assign(new Error(MESSAGES[code]), { code });
        }
      },
    });
  }
  const api = { createByokProvider };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalAiProvider = api;
})(globalThis);

/* Optional Bailian transcription UI. MIT; see ../LICENSE. */
(function (root) {
  'use strict';
  function mount({ document: doc, onPrepare, onContinue, onSaveKey, onStart }) {
    const el = id => doc.getElementById(id);
    const dialog = el('asrDialog');
    const input = el('asrKeyInput');
    let hasKey = false, consentGranted = false, changing = false, busy = false, dismissed = false;
    let restoreFocus = null;
    function close() {
      input.value = '';
      changing = false;
      consentGranted = false;
      if (dialog.open) dialog.close();
    }
    dialog.addEventListener('close', () => {
      dismissed = true;
      input.value = '';
      restoreFocus?.focus();
    });
    dialog.addEventListener('cancel', () => { input.value = ''; });
    el('asrClose').addEventListener('click', close);
    el('asrCancel').addEventListener('click', close);
    el('generateSubtitlesBtn').addEventListener('click', () => {
      if (busy) return;
      dismissed = false;
      restoreFocus = doc.activeElement;
      consentGranted = false;
      input.value = '';
      onPrepare();
    });
    el('asrContinue').addEventListener('click', () => {
      if (busy) return;
      consentGranted = true;
      el('asrContinue').disabled = true;
      onContinue();
    });
    el('asrChangeKey').addEventListener('click', () => {
      if (busy || !consentGranted) return;
      changing = true;
      el('asrKeyForm').hidden = false;
      el('asrStart').hidden = true;
      input.value = '';
      input.focus();
    });
    el('asrKeyForm').addEventListener('submit', event => {
      event.preventDefault();
      if (busy || !consentGranted) return;
      const value = input.value.trim();
      if (!value || value.length > 512) {
        input.setAttribute('aria-invalid', 'true');
        el('asrStatus').textContent = '请输入有效的百炼 API Key 后保存。';
        input.focus(); return;
      }
      input.setAttribute('aria-invalid', 'false');
      el('asrSaveKey').disabled = true;
      input.value = '';
      onSaveKey(value);
    });
    el('asrStart').addEventListener('click', () => {
      if (busy || !consentGranted || !hasKey || changing) return;
      busy = true;
      el('asrStart').disabled = true;
      onStart();
    });
    function setState(state) {
      const stage = state.stage || 'consent';
      if (stage === 'consent') { consentGranted = false; changing = false; dismissed = false; }
      if (typeof state.hasKey === 'boolean') hasKey = state.hasKey;
      if (stage === 'ready') changing = false;
      busy = stage === 'running';
      el('generateSubtitlesBtn').disabled = busy;
      el('asrStatus').textContent = state.message || '';
      el('asrConsentActions').hidden = consentGranted;
      el('asrContinue').disabled = busy;
      el('asrConfiguration').hidden = !consentGranted;
      el('asrKeyStatus').textContent = hasKey ? '已保存百炼 Key。点击“开始转写”才会处理音频。' : '尚未保存百炼 Key，请先配置。';
      el('asrKeyForm').hidden = !consentGranted || (hasKey && !changing);
      el('asrChangeKey').hidden = !hasKey || !consentGranted;
      el('asrChangeKey').disabled = busy;
      el('asrSaveKey').disabled = busy;
      input.disabled = busy;
      el('asrStart').hidden = !consentGranted || !hasKey || changing || stage === 'done' || stage === 'error';
      el('asrStart').disabled = busy;
      el('asrStart').textContent = busy ? '正在转写…' : '开始转写';
      el('asrClose').textContent = busy ? '关闭（转写继续）' : '关闭';
      dialog.setAttribute('aria-busy', String(busy));
      if (!dialog.open && !dismissed) {
        dialog.showModal();
        (stage === 'consent' ? el('asrCancel') : hasKey ? el('asrStart') : input).focus();
      }
    }
    return { offer(show) {
      el('generateSubtitlesBtn').hidden = !show;
      if (!show) { busy = false; el('generateSubtitlesBtn').disabled = false; }
    }, close, setState };
  }
  const api = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalAsrView = api;
})(globalThis);

// ==UserScript==
// @name         Mercari Todo Reply Slack Notifier
// @namespace    https://mercari.local/
// @version      0.1.0
// @description  Send Slack alerts when Mercari todo items include "返信をお願いします".
// @updateURL    __UPDATE_URL__
// @downloadURL  __DOWNLOAD_URL__
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      hooks.slack.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG_KEYS = {
    webhookUrl: 'slackWebhookUrl',
    keyword: 'keyword',
    seenHashes: 'seenHashes',
    debug: 'debug',
  };

  const DEFAULTS = {
    keyword: '返信をお願いします',
    scanIntervalMs: 30000,
    maxLoadMoreClicks: 10,
    waitAfterLoadMoreMs: 1200,
  };

  let isScanning = false;
  let lastPathname = location.pathname;

  function getConfig(key, fallback) {
    const value = GM_getValue(key);
    return value === undefined || value === null || value === '' ? fallback : value;
  }

  function setConfig(key, value) {
    GM_setValue(key, value);
  }

  function getWebhookUrl() {
    return String(getConfig(CONFIG_KEYS.webhookUrl, '')).trim();
  }

  function getKeyword() {
    return String(getConfig(CONFIG_KEYS.keyword, DEFAULTS.keyword)).trim();
  }

  function getSeenHashes() {
    const value = getConfig(CONFIG_KEYS.seenHashes, []);
    return Array.isArray(value) ? new Set(value) : new Set();
  }

  function saveSeenHashes(seenHashes) {
    setConfig(CONFIG_KEYS.seenHashes, Array.from(seenHashes));
  }

  function debugEnabled() {
    return Boolean(getConfig(CONFIG_KEYS.debug, false));
  }

  function debugLog(...args) {
    if (debugEnabled()) {
      console.log('[MercariTodoSlack]', ...args);
    }
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isTodoPage() {
    return location.pathname === '/todos' || location.pathname.startsWith('/todos/');
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function clickLoadMore() {
    let clicks = 0;
    for (let index = 0; index < DEFAULTS.maxLoadMoreClicks; index += 1) {
      const button = Array.from(document.querySelectorAll('button')).find(
        (node) => normalizeText(node.textContent) === 'もっと見る'
      );
      if (!button) {
        break;
      }
      button.click();
      clicks += 1;
      debugLog('Clicked more button', clicks);
      await sleep(DEFAULTS.waitAfterLoadMoreMs);
    }
    return clicks;
  }

  function extractTimeText(root) {
    const candidates = root.querySelectorAll('time, span, p, div');
    for (const candidate of candidates) {
      const text = normalizeText(candidate.textContent);
      if (/(秒前|分前|時間前|日前|週間前|か月前|ヶ月前|月前|たった今)/.test(text)) {
        return text;
      }
    }
    return '';
  }

  function pickHref(root) {
    const directAnchor = root.closest('a[href]');
    if (directAnchor) {
      return directAnchor.href;
    }

    const nestedAnchor = root.querySelector('a[href]');
    if (nestedAnchor) {
      return nestedAnchor.href;
    }

    return '';
  }

  function collectMatchingItems() {
    const keyword = getKeyword();
    const selectors = [
      'main a',
      'main li',
      'main article',
      'main section > div',
      '[role="main"] a',
      '[role="main"] li',
      '[role="main"] article',
    ];
    const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const seen = new Set();
    const results = [];

    for (const node of nodes) {
      const text = normalizeText(node.innerText || node.textContent);
      if (!text.includes(keyword)) {
        continue;
      }

      const href = pickHref(node);
      const timeText = extractTimeText(node);
      const key = `${text}||${timeText}||${href}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      results.push({
        text,
        timeText,
        href,
      });
    }

    return results;
  }

  function simpleHash(input) {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(index);
      hash |= 0;
    }
    return String(hash);
  }

  function buildItemHash(item) {
    return simpleHash(`${item.text}||${item.href}`);
  }

  function sendSlackMessage(text) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: getWebhookUrl(),
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ text }),
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve();
            return;
          }
          reject(new Error(`Slack webhook returned status ${response.status}`));
        },
        onerror: () => reject(new Error('Slack webhook request failed')),
      });
    });
  }

  function formatSlackMessage(item) {
    const lines = [
      'Mercari reply alert',
      `- 내용: ${item.text}`,
    ];
    if (item.timeText) {
      lines.push(`- 시각표시: ${item.timeText}`);
    }
    lines.push(`- 링크: ${item.href || location.href}`);
    return lines.join('\n');
  }

  async function scanAndNotify() {
    if (!isTodoPage() || isScanning) {
      return;
    }

    const webhookUrl = getWebhookUrl();
    if (!webhookUrl) {
      debugLog('Webhook URL not configured.');
      return;
    }

    isScanning = true;
    try {
      const loadMoreClicks = await clickLoadMore();
      const items = collectMatchingItems();
      const seenHashes = getSeenHashes();
      let newCount = 0;

      debugLog('Todo scan results', { loadMoreClicks, itemCount: items.length });

      for (const item of items) {
        const hash = buildItemHash(item);
        if (seenHashes.has(hash)) {
          continue;
        }

        await sendSlackMessage(formatSlackMessage(item));
        seenHashes.add(hash);
        newCount += 1;
      }

      saveSeenHashes(seenHashes);
      debugLog('Slack notifications sent', newCount);
    } catch (error) {
      console.error('[MercariTodoSlack] Scan failed:', error);
    } finally {
      isScanning = false;
    }
  }

  function registerMenuCommands() {
    GM_registerMenuCommand('Set Slack Webhook URL', () => {
      const current = getWebhookUrl();
      const next = window.prompt('Slack Webhook URL을 입력하세요', current);
      if (next !== null) {
        setConfig(CONFIG_KEYS.webhookUrl, next.trim());
        window.alert('Slack Webhook URL 저장 완료');
      }
    });

    GM_registerMenuCommand('Set Keyword', () => {
      const current = getKeyword();
      const next = window.prompt('감지할 문구를 입력하세요', current);
      if (next !== null) {
        setConfig(CONFIG_KEYS.keyword, next.trim() || DEFAULTS.keyword);
        window.alert('감지 문구 저장 완료');
      }
    });

    GM_registerMenuCommand('Send Slack Test Message', async () => {
      try {
        if (!getWebhookUrl()) {
          window.alert('먼저 Slack Webhook URL을 설정하세요.');
          return;
        }
        await sendSlackMessage('Mercari todo Slack notifier test\n- 상태: webhook 연결 확인 성공');
        window.alert('테스트 메시지 전송 완료');
      } catch (error) {
        window.alert(`테스트 메시지 전송 실패: ${error.message}`);
      }
    });

    GM_registerMenuCommand('Toggle Debug Logging', () => {
      const next = !debugEnabled();
      setConfig(CONFIG_KEYS.debug, next);
      window.alert(`디버그 로그 ${next ? '활성화' : '비활성화'} 완료`);
    });

    GM_registerMenuCommand('Reset Sent History', () => {
      setConfig(CONFIG_KEYS.seenHashes, []);
      window.alert('전송 이력 초기화 완료');
    });

    GM_registerMenuCommand('Run Scan Now', () => {
      scanAndNotify();
    });
  }

  function watchRouteChanges() {
    const observer = new MutationObserver(() => {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        debugLog('Route changed', lastPathname);
        scanAndNotify();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function bootstrap() {
    registerMenuCommands();
    watchRouteChanges();
    scanAndNotify();
    window.setInterval(scanAndNotify, DEFAULTS.scanIntervalMs);
  }

  bootstrap();
})();

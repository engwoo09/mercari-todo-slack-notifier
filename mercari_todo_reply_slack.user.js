// ==UserScript==
// @name         Mercari Todo Reply Slack Notifier
// @namespace    https://mercari.local/
// @version      0.2.0
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
    baselineInitialized: 'baselineInitialized',
    bulkAlertLastSentAt: 'bulkAlertLastSentAt',
  };

  const DEFAULTS = {
    keyword: '返信をお願いします',
    scanIntervalMs: 30000,
    maxLoadMoreClicks: 10,
    waitAfterLoadMoreMs: 1200,
    recentWindowDays: 30,
    bulkReloadThreshold: 10,
    bulkReloadCooldownMs: 10 * 60 * 1000,
    iframeWaitMs: 2500,
  };

  const EXCLUDED_MESSAGE_PHRASES = [
    'ご購入いただきありがとうございます。これから発送の準備をさせていただきます。設定した期日内に発送予定ですので今しばらくお待ちください。取引終了までよろしくお願いいたします。',
    '商品を発送いたしました。到着まで今しばらくお待ちください。商品が届きましたらご確認後に受け取り評価をお願いいたします。',
  ];

  let isScanning = false;
  let lastPathname = location.pathname;
  const pageTextCache = new Map();

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

  function getNow() {
    return Date.now();
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

  function canonicalizeHref(href) {
    const value = String(href || '').trim();
    if (!value) {
      return '';
    }

    try {
      const url = new URL(value, location.origin);
      url.hash = '';
      return url.toString();
    } catch (_error) {
      return value;
    }
  }

  function parseRelativeTimeText(timeText) {
    const text = normalizeText(timeText);
    if (!text) {
      return { text, eligible: false, ageDays: Number.POSITIVE_INFINITY };
    }
    if (text === 'たった今') {
      return { text, eligible: true, ageDays: 0 };
    }

    const match = text.match(/^(\d+)\s*(秒前|分前|時間前|日前|週間前|か月前|ヶ月前|月前|年前)$/);
    if (!match) {
      return { text, eligible: false, ageDays: Number.POSITIVE_INFINITY };
    }

    const value = Number(match[1]);
    const unit = match[2];
    const unitToDays = {
      秒前: 1 / 86400,
      分前: 1 / 1440,
      時間前: 1 / 24,
      日前: 1,
      週間前: 7,
      か月前: 30,
      ヶ月前: 30,
      月前: 30,
      年前: 365,
    };
    const ageDays = value * (unitToDays[unit] || Number.POSITIVE_INFINITY);
    return {
      text,
      eligible: ageDays <= DEFAULTS.recentWindowDays,
      ageDays,
    };
  }

  function isRecentEnough(timeText) {
    return parseRelativeTimeText(timeText).eligible;
  }

  function collectMatchingItems() {
    const keyword = getKeyword();
    const selectors = [
      'main a[href]',
      '[role="main"] a[href]',
    ];
    const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const seen = new Set();
    const results = [];
    const stats = {
      scannedNodes: nodes.length,
      keywordMatchedNodes: 0,
      missingTimeText: 0,
      tooOld: 0,
      duplicateRows: 0,
    };

    for (const node of nodes) {
      const text = normalizeText(node.innerText || node.textContent);
      if (!text.includes(keyword)) {
        continue;
      }
      stats.keywordMatchedNodes += 1;

      const href = canonicalizeHref(pickHref(node));
      const timeText = extractTimeText(node);
      if (!timeText) {
        stats.missingTimeText += 1;
        continue;
      }
      if (!isRecentEnough(timeText)) {
        stats.tooOld += 1;
        continue;
      }

      const key = href ? href : `${text}||${timeText}`;
      if (seen.has(key)) {
        stats.duplicateRows += 1;
        continue;
      }
      seen.add(key);

      results.push({
        text,
        timeText,
        href,
      });
    }

    return { items: results, stats };
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
    const href = canonicalizeHref(item.href);
    const stableKey = href ? href : `${item.text}||${item.timeText}`;
    return simpleHash(stableKey);
  }

  function hasInitializedBaseline() {
    return Boolean(getConfig(CONFIG_KEYS.baselineInitialized, false));
  }

  function markBaselineInitialized() {
    setConfig(CONFIG_KEYS.baselineInitialized, true);
  }

  function getBulkAlertLastSentAt() {
    return Number(getConfig(CONFIG_KEYS.bulkAlertLastSentAt, 0)) || 0;
  }

  function setBulkAlertLastSentAt(timestamp) {
    setConfig(CONFIG_KEYS.bulkAlertLastSentAt, Number(timestamp) || 0);
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

  function formatBulkReloadMessage(items) {
    const preview = items
      .slice(0, 3)
      .map((item) => `- ${item.timeText} | ${item.text}`)
      .join('\n');
    const lines = [
      'Mercari reply alert',
      `- 상태: 返信をお願いします 항목이 ${items.length}건 감지되어 페이지를 새로고침합니다.`,
      `- 기준: 최근 ${DEFAULTS.recentWindowDays}일 이내 항목만 포함`,
    ];
    if (preview) {
      lines.push('- 예시:');
      lines.push(preview);
    }
    lines.push(`- 페이지: ${location.href}`);
    return lines.join('\n');
  }

  function openHiddenIframe(url) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.width = '1px';
      iframe.style.height = '1px';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';
      iframe.style.left = '-9999px';
      iframe.style.top = '-9999px';

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        iframe.remove();
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('거래 페이지 로드 시간이 초과되었습니다.'));
      }, 15000);

      iframe.onload = async () => {
        try {
          await sleep(DEFAULTS.iframeWaitMs);
          const doc = iframe.contentDocument;
          const bodyText = normalizeText(doc?.body?.innerText || doc?.body?.textContent || '');
          cleanup();
          resolve(bodyText);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };

      iframe.src = url;
      document.body.appendChild(iframe);
    });
  }

  async function getTransactionPageText(url) {
    const href = canonicalizeHref(url);
    if (!href) {
      return '';
    }
    if (pageTextCache.has(href)) {
      return pageTextCache.get(href);
    }

    const text = await openHiddenIframe(href);
    pageTextCache.set(href, text);
    return text;
  }

  async function shouldExcludeByTransactionMessage(item) {
    if (!item.href) {
      return false;
    }

    const pageText = await getTransactionPageText(item.href);
    if (!pageText) {
      return false;
    }

    return EXCLUDED_MESSAGE_PHRASES.some((phrase) => pageText.includes(phrase));
  }

  async function maybeReloadOnBulkItems(items) {
    if (items.length < DEFAULTS.bulkReloadThreshold) {
      return false;
    }

    const now = getNow();
    const lastSentAt = getBulkAlertLastSentAt();
    if (now - lastSentAt < DEFAULTS.bulkReloadCooldownMs) {
      debugLog('Bulk reload skipped due to cooldown', { itemCount: items.length });
      return false;
    }

    await sendSlackMessage(formatBulkReloadMessage(items));
    setBulkAlertLastSentAt(now);
    debugLog('Bulk reload triggered', { itemCount: items.length });
    window.setTimeout(() => window.location.reload(), 1500);
    return true;
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
      const { items, stats } = collectMatchingItems();
      const seenHashes = getSeenHashes();
      let newCount = 0;
      let alreadySeenCount = 0;
      let excludedByTemplateCount = 0;

      debugLog('Todo scan results', {
        loadMoreClicks,
        itemCount: items.length,
        scannedNodes: stats.scannedNodes,
        keywordMatchedNodes: stats.keywordMatchedNodes,
        missingTimeText: stats.missingTimeText,
        tooOld: stats.tooOld,
        duplicateRows: stats.duplicateRows,
        baselineInitialized: hasInitializedBaseline(),
        seenHashes: seenHashes.size,
      });

      if (!hasInitializedBaseline()) {
        for (const item of items) {
          seenHashes.add(buildItemHash(item));
        }
        saveSeenHashes(seenHashes);
        markBaselineInitialized();
        debugLog('Baseline initialized without sending Slack', { itemCount: items.length });
        return;
      }

      const reloaded = await maybeReloadOnBulkItems(items);
      if (reloaded) {
        return;
      }

      for (const item of items) {
        const hash = buildItemHash(item);
        if (seenHashes.has(hash)) {
          alreadySeenCount += 1;
          continue;
        }

        const excluded = await shouldExcludeByTransactionMessage(item);
        if (excluded) {
          seenHashes.add(hash);
          excludedByTemplateCount += 1;
          debugLog('Skipped template transaction message', { href: item.href, timeText: item.timeText });
          continue;
        }

        await sendSlackMessage(formatSlackMessage(item));
        seenHashes.add(hash);
        newCount += 1;
      }

      saveSeenHashes(seenHashes);
      debugLog('Slack notifications sent', {
        sent: newCount,
        alreadySeen: alreadySeenCount,
        excludedByTemplate: excludedByTemplateCount,
        trackedHashes: seenHashes.size,
      });
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
      setConfig(CONFIG_KEYS.baselineInitialized, false);
      setConfig(CONFIG_KEYS.bulkAlertLastSentAt, 0);
      window.alert('전송 이력 초기화 완료');
    });

    GM_registerMenuCommand('Use Current List As Baseline', () => {
      const items = collectMatchingItems();
      const seenHashes = getSeenHashes();
      for (const item of items) {
        seenHashes.add(buildItemHash(item));
      }
      saveSeenHashes(seenHashes);
      markBaselineInitialized();
      window.alert(`현재 목록 ${items.length}건을 기준선으로 저장했습니다. 이후 새 항목만 알림됩니다.`);
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

// ==UserScript==
// @name         Mercari Todo Reply Slack Notifier
// @namespace    https://mercari.local/
// @version      0.4.8
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
    scanIntervalMs: 10 * 60 * 1000,
    shallowScanRetryMs: 30 * 1000,
    shallowScanNodeThreshold: 300,
    foregroundResumeCooldownMs: 15 * 1000,
    periodicRefreshMs: 11 * 60 * 1000,
    maxLoadMoreClicks: 4,
    waitAfterLoadMoreMs: 1200,
    recentWindowDays: 3,
    bulkReloadThreshold: 20,
    bulkReloadCooldownMs: 10 * 60 * 1000,
    iframeWaitMs: 2500,
    iframeMessageWaitMs: 10000,
    iframeMessagePollMs: 250,
  };

  const EXCLUDED_MESSAGE_RULES = [
    {
      key: 'purchase-greeting',
      text:
        'ご購入いただきありがとうございます。これから発送の準備をさせていただきます。設定した期日内に発送予定ですので今しばらくお待ちください。取引終了までよろしくお願いいたします。',
    },
    {
      key: 'shipping-notice',
      text:
        '商品を発送いたしました。到着まで今しばらくお待ちください。商品が届きましたらご確認後に受け取り評価をお願いいたします。',
    },
  ];

  let isScanning = false;
  let lastPathname = location.pathname;
  let scanTimerId = null;
  let periodicRefreshTimerId = null;
  let lastScanStartedAt = 0;
  let lastForegroundResumeScanAt = 0;
  const pageTextCache = new Map();

  function clearPageTextCache() {
    pageTextCache.clear();
  }

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

  function debugJson(label, payload) {
    if (debugEnabled()) {
      console.log(`[MercariTodoSlack] ${label} ${JSON.stringify(payload)}`);
    }
  }

  function getNow() {
    return Date.now();
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeCompactText(value) {
    return normalizeText(value).replace(/[\s\u3000]/g, '');
  }

  function extractNormalizedTextBlocks(value) {
    return Array.from(
      new Set(
        String(value || '')
          .split(/\n{2,}/)
          .map((part) => normalizeText(part))
          .filter((part) => part.length >= 20)
      )
    );
  }

  function getRecentWindowLabel() {
    return `최근 ${DEFAULTS.recentWindowDays}일`;
  }

  function getOlderThanWindowLabel() {
    return `${DEFAULTS.recentWindowDays}일 초과`;
  }

  function extractTransactionMessageBodies(doc) {
    const messages = [];
    const selector = '[data-testid="transaction:comment-list"] [data-testid="message-body"], [data-testid="message-body"]';
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      const text = normalizeText(node.textContent || '');
      if (text.length >= 2) {
        messages.push(text);
      }
    }
    return messages;
  }

  function extractCandidateTextsFromDocument(doc) {
    const directMessages = extractTransactionMessageBodies(doc);
    if (directMessages.length > 0) {
      return directMessages;
    }

    const candidates = new Set();
    const selectors = ['p', 'span', 'div', 'li'];
    for (const selector of selectors) {
      for (const node of Array.from(doc.querySelectorAll(selector))) {
        const text = normalizeText(node.textContent || '');
        if (text.length >= 20 && text.length <= 220) {
          candidates.add(text);
        }
      }
    }

    const bodyText = normalizeText(doc?.body?.innerText || doc?.body?.textContent || '');
    for (const block of extractNormalizedTextBlocks(bodyText)) {
      candidates.add(block);
    }

    return Array.from(candidates);
  }

  async function waitForTransactionMessages(doc) {
    const deadline = getNow() + DEFAULTS.iframeMessageWaitMs;
    while (getNow() < deadline) {
      const messages = extractTransactionMessageBodies(doc);
      if (messages.length > 0) {
        return messages;
      }
      await sleep(DEFAULTS.iframeMessagePollMs);
    }
    return [];
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

  function getCandidateRoots() {
    const roots = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('#__next'),
      document.body,
    ].filter(Boolean);

    return Array.from(new Set(roots));
  }

  function getCandidateNodes() {
    const selector = [
      'a[href]',
      'li',
      'article',
      '[data-testid]',
      'section > div',
      'div',
    ].join(', ');

    const seen = new Set();
    const nodes = [];

    for (const root of getCandidateRoots()) {
      const found = [root, ...Array.from(root.querySelectorAll(selector))];
      for (const node of found) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (seen.has(node)) {
          continue;
        }
        seen.add(node);
        nodes.push(node);
      }
    }

    return nodes;
  }

  function collectMatchingItems() {
    const keyword = getKeyword();
    const nodes = getCandidateNodes();
    const seen = new Set();
    const results = [];
    const stats = {
      scannedNodes: nodes.length,
      keywordMatchedNodes: 0,
      missingTimeText: 0,
      tooOld: 0,
      duplicateRows: 0,
    };

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const text = normalizeText(node.innerText || node.textContent);
      if (!text || text.length > 500) {
        continue;
      }
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
      const timeMeta = parseRelativeTimeText(timeText);
      if (!timeMeta.eligible) {
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
        ageDays: timeMeta.ageDays,
        sourceIndex: index,
      });
    }

    results.sort((left, right) => {
      if (left.ageDays !== right.ageDays) {
        return left.ageDays - right.ageDays;
      }
      return left.sourceIndex - right.sourceIndex;
    });

    return {
      items: results,
      stats,
    };
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
    if (item.previewText) {
      lines.push(`- 메시지본문: ${item.previewText}`);
    }
    if (item.timeText) {
      lines.push(`- 시각표시: ${item.timeText}`);
    }
    lines.push(`- 링크: ${item.href || location.href}`);
    return lines.join('\n');
  }

  function formatScanCompletedMessage(scanStats, sentStats, meta = {}) {
    const lines = [
      'Mercari scan completed',
      `- 상태: 완료`,
    ];
    if (sentStats.sent > 0) {
      lines.push(`- 알림전송: ${sentStats.sent}건`);
    }
    if (meta.nextScanInMinutes) {
      lines.push(`- 다음스캔: 약 ${meta.nextScanInMinutes}분 후`);
    }
    if (meta.reloading) {
      lines.push('- 후속동작: 페이지 새로고침 예정');
    }
    if (meta.shallowRetryInSeconds) {
      lines.push(`- 후속동작: 목록 재확인 ${meta.shallowRetryInSeconds}초 후`);
    }
    if (meta.reloadThresholdActive) {
      lines.push(`- 후속동작: 필터통과 누적 ${DEFAULTS.bulkReloadThreshold}건 이상이면 새로고침 판단`);
    }
    lines.push(`- 페이지: ${location.href}`);
    return lines.join('\n');
  }

  function formatPlannedNotificationsMessage(scanStats, planStats) {
    const lines = [
      'Mercari reply alert batch',
      `- 필터통과누적: ${planStats.pending}건`,
      `- 이번스캔전송: ${planStats.toSend}건`,
      `- 기존이력제외: ${planStats.alreadySeen}건`,
      `- 템플릿제외: ${planStats.excludedByTemplate}건`,
    ];
    if (planStats.templateCheckErrors) {
      lines.push(`- 거래화면확인실패: ${planStats.templateCheckErrors}건`);
    }
    lines.push(`- ${getRecentWindowLabel()} 대상: ${scanStats.itemCount}건`);
    lines.push(`- 페이지: ${location.href}`);
    return lines.join('\n');
  }

  function shouldRetryShallowScan(scanStats) {
    if (scanStats.loadMoreClicks > 0) {
      return false;
    }
    if (scanStats.itemCount > 0 || scanStats.keywordMatchedNodes > 0) {
      return false;
    }
    return scanStats.scannedNodes < DEFAULTS.shallowScanNodeThreshold;
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
        iframe.src = 'about:blank';
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
          const waitedMessages = doc ? await waitForTransactionMessages(doc) : [];
          const bodyText = waitedMessages.length > 0
            ? normalizeText(waitedMessages.join('\n\n'))
            : '';
          const candidateTexts = waitedMessages.length > 0
            ? waitedMessages
            : [];
          cleanup();
          resolve({
            bodyText,
            candidateTexts,
          });
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

    const pageContent = await openHiddenIframe(href);
    pageTextCache.set(href, pageContent);
    return pageContent;
  }

  function shouldKeepPreviewCandidate(text, item) {
    const normalized = normalizeText(text);
    const compact = normalizeCompactText(text);
    if (!normalized || normalized.length < 8) {
      return false;
    }
    if (compact === normalizeCompactText(item.text || '')) {
      return false;
    }
    if (compact === normalizeCompactText(item.timeText || '')) {
      return false;
    }
    if (normalized.includes('返信をお願いします')) {
      return false;
    }
    if (normalized.includes('取引メッセージがあります')) {
      return false;
    }
    if (normalized.includes('事務局') || normalized.includes('メルカリ')) {
      return false;
    }
    return true;
  }

  function pickPreviewText(item, candidateTexts) {
    const filtered = candidateTexts
      .map((text) => normalizeText(text))
      .filter((text) => shouldKeepPreviewCandidate(text, item))
      .sort((left, right) => right.length - left.length);

    return filtered.length > 0 ? filtered[0].slice(0, 200) : '';
  }

  async function analyzeTransactionPage(item) {
    if (!item.href) {
      return {
        excludedMatch: null,
        previewText: '',
      };
    }

    const pageContent = await getTransactionPageText(item.href);
    if (!pageContent) {
      return {
        excludedMatch: null,
        previewText: '',
      };
    }
    const candidateTexts = Array.isArray(pageContent.candidateTexts) ? pageContent.candidateTexts : [];
    const latestMessageText = candidateTexts.length > 0 ? normalizeText(candidateTexts[candidateTexts.length - 1]) : '';
    const latestCompactText = normalizeCompactText(latestMessageText);
    let excludedMatch = null;

    for (const rule of EXCLUDED_MESSAGE_RULES) {
      const normalizedTemplate = normalizeText(rule.text);
      const compactTemplate = normalizeCompactText(rule.text);
      if (compactTemplate && latestCompactText === compactTemplate) {
        excludedMatch = {
          key: rule.key,
          matchedText: normalizedTemplate,
        };
        break;
      }
    }

    return {
      excludedMatch,
      previewText: latestMessageText || pickPreviewText(item, candidateTexts),
    };
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
    return true;
  }

  function scheduleNextScan(delayMs = DEFAULTS.scanIntervalMs) {
    if (scanTimerId) {
      window.clearTimeout(scanTimerId);
    }
    scanTimerId = window.setTimeout(() => {
      scanTimerId = null;
      scanAndNotify({ reason: 'scheduled', shouldScheduleNext: true });
    }, delayMs);
    debugJson('Next scan scheduled', {
      delayMs,
      nextScanInMinutes: Math.round((delayMs / 60000) * 10) / 10,
    });
  }

  function schedulePeriodicRefresh(delayMs = DEFAULTS.periodicRefreshMs) {
    if (periodicRefreshTimerId) {
      window.clearTimeout(periodicRefreshTimerId);
    }
    periodicRefreshTimerId = window.setTimeout(() => {
      periodicRefreshTimerId = null;
      if (!isTodoPage() || isScanning) {
        schedulePeriodicRefresh(DEFAULTS.periodicRefreshMs);
        return;
      }
      debugJson('Periodic refresh triggered', {
        delayMs,
        msSinceLastScanStart: lastScanStartedAt ? getNow() - lastScanStartedAt : null,
      });
      window.location.reload();
    }, delayMs);
    debugJson('Periodic refresh scheduled', {
      delayMs,
      nextRefreshInMinutes: Math.round((delayMs / 60000) * 10) / 10,
    });
  }

  async function scanAndNotify(options = {}) {
    const {
      reason = 'manual',
      shouldScheduleNext = false,
    } = options;

    if (!isTodoPage() || isScanning) {
      return;
    }

    const webhookUrl = getWebhookUrl();
    if (!webhookUrl) {
      debugLog('Webhook URL not configured.');
      return;
    }

    isScanning = true;
    lastScanStartedAt = getNow();
    try {
      const loadMoreClicks = await clickLoadMore();
      const { items, stats } = collectMatchingItems();
      const seenHashes = getSeenHashes();
      let newCount = 0;
      let alreadySeenCount = 0;
      let excludedByTemplateCount = 0;
      let templateCheckErrorCount = 0;

      const scanStats = {
        loadMoreClicks,
        itemCount: items.length,
        scannedNodes: stats.scannedNodes,
        keywordMatchedNodes: stats.keywordMatchedNodes,
        missingTimeText: stats.missingTimeText,
        tooOld: stats.tooOld,
        duplicateRows: stats.duplicateRows,
        baselineInitialized: hasInitializedBaseline(),
        seenHashes: seenHashes.size,
      };
      debugLog('Todo scan results', scanStats);
      debugJson('Todo scan results summary', scanStats);

      if (shouldRetryShallowScan(scanStats)) {
        debugLog('Shallow scan detected, retrying soon', scanStats);
        if (shouldScheduleNext && isTodoPage()) {
          scheduleNextScan(DEFAULTS.shallowScanRetryMs);
        }
        await sendSlackMessage(
          formatScanCompletedMessage(
            scanStats,
            {
              sent: 0,
              alreadySeen: 0,
              excludedByTemplate: 0,
              templateCheckErrors: 0,
            },
            {
              reason: `${reason}-shallow-retry`,
              shallowRetryInSeconds: Math.round(DEFAULTS.shallowScanRetryMs / 1000),
            }
          )
        );
        return;
      }

      if (!hasInitializedBaseline()) {
        for (const item of items) {
          seenHashes.add(buildItemHash(item));
        }
        saveSeenHashes(seenHashes);
        markBaselineInitialized();
        debugLog('Baseline initialized without sending Slack', { itemCount: items.length });
        await sendSlackMessage(
          formatScanCompletedMessage(
            scanStats,
            {
              sent: 0,
              alreadySeen: 0,
              excludedByTemplate: 0,
              templateCheckErrors: 0,
            },
            {
              reason: `${reason}-baseline`,
              nextScanInMinutes: shouldScheduleNext ? Math.round((DEFAULTS.scanIntervalMs / 60000) * 10) / 10 : 0,
            }
          )
        );
        return;
      }

      const pendingItems = [];

      for (const item of items) {
        const hash = buildItemHash(item);
        if (seenHashes.has(hash)) {
          alreadySeenCount += 1;
          continue;
        }

        let analysis = {
          excludedMatch: null,
          previewText: '',
        };
        try {
          analysis = await analyzeTransactionPage(item);
        } catch (error) {
          templateCheckErrorCount += 1;
          debugLog('Template check failed, sending alert without exclusion', {
            href: item.href,
            timeText: item.timeText,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if (analysis.excludedMatch) {
          seenHashes.add(hash);
          excludedByTemplateCount += 1;
          debugLog('Skipped template transaction message', {
            href: item.href,
            timeText: item.timeText,
            templateKey: analysis.excludedMatch.key,
          });
          continue;
        }

        pendingItems.push({
          item: {
            ...item,
            previewText: analysis.previewText,
          },
          hash,
        });
      }

      const shouldReloadAfterScan = await maybeReloadOnBulkItems(pendingItems.map((entry) => entry.item));
      const itemsToSend = pendingItems;
      const shouldSendAlerts = pendingItems.length > 0;

      if (shouldSendAlerts) {
        await sendSlackMessage(
          formatPlannedNotificationsMessage(scanStats, {
            pending: pendingItems.length,
            toSend: itemsToSend.length,
            alreadySeen: alreadySeenCount,
            excludedByTemplate: excludedByTemplateCount,
            templateCheckErrors: templateCheckErrorCount,
          })
        );
      }

      if (shouldSendAlerts) {
        for (const pendingItem of itemsToSend) {
          await sendSlackMessage(formatSlackMessage(pendingItem.item));
          seenHashes.add(pendingItem.hash);
          newCount += 1;
        }
      }

      saveSeenHashes(seenHashes);
      const sentStats = {
        sent: newCount,
        alreadySeen: alreadySeenCount,
        excludedByTemplate: excludedByTemplateCount,
        templateCheckErrors: templateCheckErrorCount,
        trackedHashes: seenHashes.size,
      };
      debugLog('Slack notifications sent', sentStats);
      debugJson('Slack notifications sent summary', sentStats);
      await sendSlackMessage(
        formatScanCompletedMessage(
          scanStats,
          sentStats,
          {
            reason,
            nextScanInMinutes: shouldScheduleNext ? Math.round((DEFAULTS.scanIntervalMs / 60000) * 10) / 10 : 0,
            reloading: shouldReloadAfterScan,
            reloadThresholdActive: !shouldReloadAfterScan,
          }
        )
      );
      if (shouldReloadAfterScan) {
        window.setTimeout(() => window.location.reload(), 1500);
      }
    } catch (error) {
      console.error('[MercariTodoSlack] Scan failed:', error);
    } finally {
      isScanning = false;
      clearPageTextCache();
      if (shouldScheduleNext && isTodoPage() && !scanTimerId) {
        scheduleNextScan(DEFAULTS.scanIntervalMs);
      }
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

    GM_registerMenuCommand('Clear Seen Hashes Keep Baseline', () => {
      setConfig(CONFIG_KEYS.seenHashes, []);
      window.alert('기준선은 유지하고 전송 이력만 비웠습니다. 현재 목록도 다시 검사 대상이 됩니다.');
    });

    GM_registerMenuCommand('Use Current List As Baseline', () => {
      const { items } = collectMatchingItems();
      const seenHashes = getSeenHashes();
      for (const item of items) {
        seenHashes.add(buildItemHash(item));
      }
      saveSeenHashes(seenHashes);
      markBaselineInitialized();
      window.alert(`현재 목록 ${items.length}건을 기준선으로 저장했습니다. 이후 새 항목만 알림됩니다.`);
    });

    GM_registerMenuCommand('Run Scan Now', () => {
      scanAndNotify({ reason: 'manual', shouldScheduleNext: false });
    });
  }

  function watchRouteChanges() {
    const observer = new MutationObserver(() => {
      if (location.pathname !== lastPathname) {
        lastPathname = location.pathname;
        clearPageTextCache();
        debugLog('Route changed', lastPathname);
        scanAndNotify({ reason: 'route-change', shouldScheduleNext: false });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function maybeRunForegroundResumeScan(trigger) {
    if (!isTodoPage() || isScanning) {
      return;
    }

    const now = getNow();
    if (now - lastForegroundResumeScanAt < DEFAULTS.foregroundResumeCooldownMs) {
      return;
    }

    lastForegroundResumeScanAt = now;
    debugLog('Foreground resume scan triggered', {
      trigger,
      msSinceLastScanStart: lastScanStartedAt ? now - lastScanStartedAt : null,
      documentHidden: document.hidden,
    });
    scanAndNotify({ reason: `foreground-resume-${trigger}`, shouldScheduleNext: true });
  }

  function watchForegroundResume() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        maybeRunForegroundResumeScan('visibilitychange');
      }
    });

    window.addEventListener('focus', () => {
      maybeRunForegroundResumeScan('focus');
    });

    window.addEventListener('pageshow', () => {
      maybeRunForegroundResumeScan('pageshow');
    });
  }

  function bootstrap() {
    registerMenuCommands();
    watchRouteChanges();
    watchForegroundResume();
    schedulePeriodicRefresh();
    scanAndNotify({ reason: 'bootstrap', shouldScheduleNext: true });
  }

  bootstrap();
})();

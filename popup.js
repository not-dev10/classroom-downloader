// ============================================================
// Classroom Downloader — Popup Script
// ============================================================

(function () {
  'use strict';

  // --------------- DOM References ---------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elements = {
    courseName: $('#courseName'),
    pageType: $('#pageType'),
    materialCount: $('#materialCount'),
    selectedCount: $('#selectedCount'),
    selectedRow: $('#selectedRow'),
    notClassroom: $('#notClassroom'),
    pageInfoSection: $('#pageInfoSection'),
    actionsSection: $('#actionsSection'),
    downloadAllBtn: $('#downloadAllBtn'),
    selectAllBtn: $('#selectAllBtn'),
    downloadSelectedBtn: $('#downloadSelectedBtn'),
    zipAllBtn: $('#zipAllBtn'),
    scanBtn: $('#scanBtn'),
    historyList: $('#historyList'),
    clearHistoryBtn: $('#clearHistoryBtn'),
    saveSettingsBtn: $('#saveSettingsBtn'),
    historyPanel: $('#historyPanel'),
    settingsPanel: $('#settingsPanel'),
  };

  // --------------- State ---------------
  let currentTabId = null;
  let isClassroom = false;

  // --------------- Init ---------------
  async function init() {
    await loadSettings();
    await detectTab();
    setupEventListeners();
    loadHistory();
  }

  // --------------- Tab Detection ---------------
  async function detectTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return showNotClassroom();

      currentTabId = tab.id;
      const url = tab.url || '';

      if (!url.startsWith('https://classroom.google.com')) {
        return showNotClassroom();
      }

      isClassroom = true;
      showClassroom();

      // Get page info from content script
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getPageInfo' });
        if (response) {
          updatePageInfo(response);
        }
      } catch (err) {
        // Content script might not be injected yet
        elements.courseName.textContent = 'Loading...';
        elements.materialCount.textContent = '—';
        console.log('Content script not ready:', err.message);
      }
    } catch (err) {
      showNotClassroom();
    }
  }

  function showNotClassroom() {
    elements.notClassroom.style.display = 'block';
    elements.pageInfoSection.style.display = 'none';
    elements.actionsSection.style.display = 'none';
  }

  function showClassroom() {
    elements.notClassroom.style.display = 'none';
    elements.pageInfoSection.style.display = 'block';
    elements.actionsSection.style.display = 'flex';
  }

  function updatePageInfo(data) {
    const { pageInfo, attachmentCount, selectedCount } = data;

    elements.courseName.textContent = pageInfo?.courseName || 'Google Classroom';

    const pageTypes = {
      stream: 'Stream',
      classwork: 'Classwork',
      assignment: 'Assignment',
      material: 'Material',
      home: 'Home',
      unknown: 'Page',
    };
    elements.pageType.textContent = pageTypes[pageInfo?.type] || 'Page';

    elements.materialCount.textContent = attachmentCount || 0;

    if (selectedCount > 0) {
      elements.selectedRow.style.display = 'flex';
      elements.selectedCount.textContent = selectedCount;
      elements.downloadSelectedBtn.disabled = false;
    } else {
      elements.selectedRow.style.display = 'none';
      elements.downloadSelectedBtn.disabled = true;
    }

    // Disable actions if no materials
    const hasFiles = attachmentCount > 0;
    elements.downloadAllBtn.disabled = !hasFiles;
    elements.zipAllBtn.disabled = !hasFiles;
    elements.selectAllBtn.disabled = !hasFiles;
  }

  // --------------- Event Listeners ---------------
  function setupEventListeners() {
    // Download All
    elements.downloadAllBtn.addEventListener('click', () => {
      if (!isClassroom) return;
      sendToContent('triggerDownloadAll');
      window.close();
    });

    // Select All
    elements.selectAllBtn.addEventListener('click', () => {
      if (!isClassroom) return;
      sendToContent('triggerSelectAll');
      // Refresh info
      setTimeout(async () => {
        try {
          const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getPageInfo' });
          if (response) updatePageInfo(response);
        } catch {}
      }, 300);
    });

    // Download Selected
    elements.downloadSelectedBtn.addEventListener('click', () => {
      if (!isClassroom) return;
      sendToContent('triggerDownloadSelected');
      window.close();
    });

    // ZIP All
    elements.zipAllBtn.addEventListener('click', () => {
      if (!isClassroom) return;
      sendToContent('triggerZipAll');
      window.close();
    });

    // Scan
    elements.scanBtn.addEventListener('click', async () => {
      if (!isClassroom) return;
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'scanPage' });
        if (response) {
          elements.materialCount.textContent = response.totalAttachments;
        }
      } catch {}
    });

    // Tabs
    $$('.cd-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.cd-tab').forEach(t => t.classList.remove('cd-tab-active'));
        tab.classList.add('cd-tab-active');

        const panelName = tab.dataset.tab;
        elements.historyPanel.style.display = panelName === 'history' ? 'block' : 'none';
        elements.settingsPanel.style.display = panelName === 'settings' ? 'block' : 'none';
      });
    });

    // Clear History
    elements.clearHistoryBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'clearHistory' });
      elements.historyList.innerHTML = '<div class="cd-empty-state">No downloads yet</div>';
    });

    // Save Settings
    elements.saveSettingsBtn.addEventListener('click', saveSettings);
  }

  function sendToContent(action) {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { action }).catch(() => {});
    }
  }

  // --------------- History ---------------
  async function loadHistory() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getDownloadHistory' });
      const history = response?.history || [];

      if (history.length === 0) {
        elements.historyList.innerHTML = '<div class="cd-empty-state">No downloads yet</div>';
        return;
      }

      elements.historyList.innerHTML = '';
      const recent = history.slice(0, 50);

      for (const item of recent) {
        const el = createHistoryItem(item);
        elements.historyList.appendChild(el);
      }
    } catch {}
  }

  function createHistoryItem(item) {
    const div = document.createElement('div');
    div.className = 'cd-history-item';

    const typeIcons = {
      drive: '📄',
      doc: '📝',
      sheet: '📊',
      slide: '📽️',
      drawing: '🎨',
      direct: '📎',
      zip: '📦',
    };

    const icon = typeIcons[item.type] || '📄';
    const time = formatTime(item.timestamp);
    const statusClass = item.status === 'completed' ? 'completed' : 'failed';

    div.innerHTML = `
      <span class="cd-history-icon">${icon}</span>
      <div class="cd-history-info">
        <div class="cd-history-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
        <div class="cd-history-meta">${time}</div>
      </div>
      <span class="cd-history-status ${statusClass}">${item.status}</span>
      ${item.status === 'failed' ? `<button class="cd-history-retry" data-id="${item.id}" title="Retry">↻</button>` : ''}
    `;

    // Retry button handler
    const retryBtn = div.querySelector('.cd-history-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'retryDownload', fileId: item.id });
      });
    }

    return div;
  }

  // --------------- Settings ---------------
  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
      const settings = response?.settings || {};

      if (settings.defaultBehavior) {
        $('#settingBehavior').value = settings.defaultBehavior;
      }
      if (settings.docExportFormat) {
        $('#settingDocFormat').value = settings.docExportFormat;
      }
      if (settings.sheetExportFormat) {
        $('#settingSheetFormat').value = settings.sheetExportFormat;
      }
      if (settings.slideExportFormat) {
        $('#settingSlideFormat').value = settings.slideExportFormat;
      }
      if (settings.maxConcurrent) {
        $('#settingConcurrent').value = settings.maxConcurrent.toString();
      }
      if (settings.preserveFolders !== undefined) {
        $('#settingFolders').checked = settings.preserveFolders;
      }
      if (settings.skipDownloaded !== undefined) {
        $('#settingSkipDownloaded').checked = settings.skipDownloaded;
      }
      if (settings.showNotifications !== undefined) {
        $('#settingNotifications').checked = settings.showNotifications;
      }
      if (settings.theme) {
        $('#settingTheme').value = settings.theme;
        applyTheme(settings.theme);
      }
    } catch {}
  }

  async function saveSettings() {
    const settings = {
      defaultBehavior: $('#settingBehavior').value,
      docExportFormat: $('#settingDocFormat').value,
      sheetExportFormat: $('#settingSheetFormat').value,
      slideExportFormat: $('#settingSlideFormat').value,
      maxConcurrent: parseInt($('#settingConcurrent').value, 10),
      preserveFolders: $('#settingFolders').checked,
      skipDownloaded: $('#settingSkipDownloaded').checked,
      showNotifications: $('#settingNotifications').checked,
      theme: $('#settingTheme').value,
    };

    await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
    applyTheme(settings.theme);

    // Flash save confirmation
    elements.saveSettingsBtn.textContent = '✓ Saved!';
    setTimeout(() => {
      elements.saveSettingsBtn.textContent = 'Save Settings';
    }, 1500);
  }

  function applyTheme(theme) {
    document.body.classList.remove('cd-theme-light', 'cd-theme-dark');
    if (theme === 'light') {
      document.body.classList.add('cd-theme-light');
    } else if (theme === 'dark') {
      document.body.classList.add('cd-theme-dark');
    }
    // 'system' — no class, uses prefers-color-scheme
  }

  // --------------- Utilities ---------------
  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --------------- Start ---------------
  init();
})();

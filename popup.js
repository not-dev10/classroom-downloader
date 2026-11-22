// ============================================================
// Classroom Downloader — Popup Script
// ============================================================

(function () {
  'use strict';

  // --------------- DOM Elements ---------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elements = {
    courseName: $('#courseName'),
    courseChip: $('#courseChip'),
    pageType: $('#pageType'),
    accountName: $('#accountName'),
    classroomContent: $('#classroomContent'),
    notClassroom: $('#notClassroom'),
    homeNotice: $('#homeNotice'),
    tabFilesBadge: $('#tabFilesBadge'),
    fileSearchInput: $('#fileSearchInput'),
    searchClearBtn: $('#searchClearBtn'),
    popupSelectAll: $('#popupSelectAll'),
    popupDeselectAll: $('#popupDeselectAll'),
    expandAllBtn: $('#expandAllBtn'),
    emptyExpandBtn: $('#emptyExpandBtn'),
    printPdfBtn: $('#printPdfBtn'),
    printPdfActionBtn: $('#printPdfActionBtn'),
    selectedStats: $('#selectedStats'),
    filesList: $('#filesList'),
    filesEmptyState: $('#filesEmptyState'),
    emptyStateTitle: $('#emptyStateTitle'),
    emptyStateTip: $('#emptyStateTip'),
    downloadActionBtn: $('#downloadActionBtn'),
    downloadActionText: $('#downloadActionText'),
    zipActionBtn: $('#zipActionBtn'),
    scanBtn: $('#scanBtn'),
    emptyRescanBtn: $('#emptyRescanBtn'),
    historyList: $('#historyList'),
    clearHistoryBtn: $('#clearHistoryBtn'),
    saveSettingsBtn: $('#saveSettingsBtn'),
    filesPanel: $('#filesPanel'),
    historyPanel: $('#historyPanel'),
    settingsPanel: $('#settingsPanel'),
    logsPanel: $('#logsPanel'),
    logsContainer: $('#logsContainer'),
    clearLogsBtn: $('#clearLogsBtn'),
    driveViewerSection: $('#driveViewerSection'),
    driveViewerTitle: $('#driveViewerTitle'),
    drivePrintPdfBtn: $('#drivePrintPdfBtn'),
  };

  // --------------- State ---------------
  let currentTabId = null;
  let isClassroom = false;
  let attachmentsList = [];
  let filterQuery = '';
  let currentPageType = '';

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

      if (url.includes('drive.google.com/file/') || url.includes('docs.google.com/')) {
        return showDriveViewer(tab);
      }

      if (!url.startsWith('https://classroom.google.com')) {
        return showNotClassroom();
      }

      isClassroom = true;
      showClassroom();

      // Request data from content script
      try {
        const response = await chrome.tabs.sendMessage(currentTabId, { action: 'getPageInfo' });
        if (response) {
          updateView(response);
        }
      } catch (err) {
        elements.courseName.textContent = 'Loading Classroom...';
        console.warn('Content script not ready:', err.message);
      }
    } catch (err) {
      showNotClassroom();
    }
  }

  function showNotClassroom() {
    if (elements.driveViewerSection) elements.driveViewerSection.style.display = 'none';
    elements.notClassroom.style.display = 'flex';
    elements.classroomContent.style.display = 'none';
  }

  function showClassroom() {
    if (elements.driveViewerSection) elements.driveViewerSection.style.display = 'none';
    elements.notClassroom.style.display = 'none';
    elements.classroomContent.style.display = 'block';
  }

  function showDriveViewer(tab) {
    if (elements.notClassroom) elements.notClassroom.style.display = 'none';
    if (elements.classroomContent) elements.classroomContent.style.display = 'none';
    if (elements.driveViewerSection) {
      elements.driveViewerSection.style.display = 'block';
      const cleanTitle = (tab.title || 'Document').replace(/\s*-\s*Google (?:Drive|Docs|Slides|Sheets)$/i, '');
      if (elements.driveViewerTitle) elements.driveViewerTitle.textContent = cleanTitle;

      elements.drivePrintPdfBtn.onclick = () => {
        elements.drivePrintPdfBtn.textContent = 'Opening Print Dialog (Ctrl+P)...';
        chrome.runtime.sendMessage({
          action: 'printActiveTab',
          tabId: tab.id,
        });
        setTimeout(() => window.close(), 600);
      };
    }
  }

  function updateView(data) {
    const { pageInfo, sessionUser, attachmentCount, selectedCount, attachments } = data;

    // Course info
    const name = pageInfo?.courseName || 'Google Classroom';
    elements.courseName.textContent = name;
    elements.courseChip.textContent = name.length > 18 ? name.substring(0, 16) + '...' : name;

    // Account info
    if (sessionUser && elements.accountName) {
      elements.accountName.textContent = sessionUser.displayLabel || sessionUser.email || `Account ${sessionUser.authIndex}`;
      elements.accountName.title = `Authenticated session: ${sessionUser.email || sessionUser.authIndex}`;
    }

    currentPageType = pageInfo?.type || 'unknown';
    const pageTypes = {
      stream: 'Stream',
      classwork: 'Classwork',
      assignment: 'Assignment',
      material: 'Material',
      home: 'Dashboard',
      unknown: 'Classroom',
    };
    elements.pageType.textContent = pageTypes[currentPageType] || 'Classwork';

    // Show home notice if on dashboard
    if (currentPageType === 'home') {
      elements.homeNotice.classList.remove('cd-hidden');
    } else {
      elements.homeNotice.classList.add('cd-hidden');
    }

    // Attachments list
    attachmentsList = attachments || [];
    elements.tabFilesBadge.textContent = attachmentsList.length;

    renderFilesList();
    updateSelectionUI();
  }

  // --------------- Render Files List ---------------
  function renderFilesList() {
    const filtered = attachmentsList.filter(file => {
      if (!filterQuery) return true;
      const q = filterQuery.toLowerCase();
      return (
        file.fileName?.toLowerCase().includes(q) ||
        file.assignmentName?.toLowerCase().includes(q) ||
        file.topicName?.toLowerCase().includes(q) ||
        file.type?.toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      let emptyTitle = 'No materials detected on this page';
      let emptyTip = 'Open an assignment or click into the Classwork tab to find attachments.';

      if (filterQuery) {
        emptyTitle = 'No materials match your search';
        emptyTip = 'Try another keyword or clear the search filter.';
      } else if (currentPageType === 'home') {
        emptyTitle = 'Classes Dashboard';
        emptyTip = 'You are currently viewing all your classes. Click into a course to download its files.';
      } else if (currentPageType === 'classwork') {
        emptyTitle = 'Assignments May Be Collapsed';
        emptyTip = 'Click "Expand All Assignments" below to open coursework accordions and reveal attachments.';
      }

      elements.filesList.innerHTML = `
        <div class="cd-empty-state">
          <div class="cd-empty-icon">${filterQuery ? '🔍' : '📂'}</div>
          <p>${emptyTitle}</p>
          <span class="cd-empty-tip">${emptyTip}</span>
          ${currentPageType !== 'home' && !filterQuery ? `
            <div class="cd-empty-actions">
              <button class="cd-btn cd-btn-primary cd-btn-sm" id="emptyExpandBtn">
                📂 Expand All Assignments
              </button>
              <button class="cd-btn cd-btn-outline cd-btn-sm" id="emptyRescanBtn">
                🔍 Rescan
              </button>
            </div>
          ` : ''}
        </div>
      `;

      // Re-attach empty state action buttons
      $('#emptyExpandBtn')?.addEventListener('click', handleExpandAll);
      $('#emptyRescanBtn')?.addEventListener('click', handleRescan);
      return;
    }

    elements.filesList.innerHTML = '';

    filtered.forEach(file => {
      const row = document.createElement('div');
      row.className = `cd-file-row ${file.selected ? 'cd-selected-row' : ''}`;
      row.setAttribute('data-id', file.id);

      const typeMeta = getTypeMetadata(file.type, file.fileName);

      row.innerHTML = `
        <label class="cd-file-check-label" title="Select for bulk download">
          <input type="checkbox" class="cd-file-checkbox" data-file-id="${file.id}" ${file.selected ? 'checked' : ''} />
        </label>
        <div class="cd-file-icon-box ${file.type}" title="${typeMeta.label}">
          ${typeMeta.icon}
        </div>
        <div class="cd-file-info">
          <div class="cd-file-title" title="${escapeHtml(file.fileName)}">${escapeHtml(file.fileName)}</div>
          <div class="cd-file-subtext">
            ${file.assignmentName ? `<span class="cd-badge-sub" title="${escapeHtml(file.assignmentName)}">${escapeHtml(file.assignmentName)}</span>` : ''}
            <span class="cd-type-label">${typeMeta.label}</span>
          </div>
        </div>
        <div class="cd-file-actions-group">
          <button class="cd-file-download-btn" data-file-id="${file.id}" title="Download: ${escapeHtml(file.fileName)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          <button class="cd-file-pdf-btn" data-file-id="${file.id}" title="Save/Print as PDF (Ctrl+P): ${escapeHtml(file.fileName)}">
            PDF
          </button>
        </div>
      `;

      // Checkbox event
      const cb = row.querySelector('.cd-file-checkbox');
      cb.addEventListener('change', (e) => {
        const checked = e.target.checked;
        file.selected = checked;
        row.classList.toggle('cd-selected-row', checked);
        syncFileSelection(file.id, checked);
        updateSelectionUI();
      });

      // Individual download button event
      const dlBtn = row.querySelector('.cd-file-download-btn');
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerSingleDownload(file, dlBtn);
      });

      // Individual Save as PDF (Ctrl+P) button event
      const pdfBtn = row.querySelector('.cd-file-pdf-btn');
      pdfBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        triggerPdfAction(file, pdfBtn);
      });

      elements.filesList.appendChild(row);
    });
  }

  function getTypeMetadata(type, fileName = '') {
    const fn = (fileName || '').toLowerCase();
    if (fn.endsWith('.pdf')) return { label: 'PDF Document (.pdf)', icon: '📕' };
    if (fn.endsWith('.pptx') || fn.endsWith('.ppt')) return { label: 'PowerPoint (.pptx)', icon: '📽️' };
    if (fn.endsWith('.docx') || fn.endsWith('.doc')) return { label: 'Word Document (.docx)', icon: '📝' };
    if (fn.endsWith('.xlsx') || fn.endsWith('.xls')) return { label: 'Excel Spreadsheet (.xlsx)', icon: '📊' };
    if (fn.endsWith('.csv')) return { label: 'CSV Spreadsheet (.csv)', icon: '📑' };
    if (fn.endsWith('.zip') || fn.endsWith('.rar') || fn.endsWith('.7z')) return { label: 'Archive (.zip)', icon: '📦' };
    if (fn.endsWith('.txt')) return { label: 'Text Document (.txt)', icon: '📄' };
    if (fn.endsWith('.png') || fn.endsWith('.jpg') || fn.endsWith('.jpeg')) return { label: 'Image', icon: '🖼️' };

    switch (type) {
      case 'doc':
        return { label: 'Google Doc', icon: '📝' };
      case 'sheet':
        return { label: 'Google Sheet', icon: '📊' };
      case 'slide':
        return { label: 'Google Slides', icon: '📽️' };
      case 'drawing':
        return { label: 'Drawing', icon: '🎨' };
      case 'drive':
        return { label: 'Drive File', icon: '📄' };
      default:
        return { label: 'Attachment', icon: '📎' };
    }
  }

  function updateSelectionUI() {
    const selectedCount = attachmentsList.filter(f => f.selected).length;
    const totalCount = attachmentsList.length;

    elements.selectedStats.textContent = `${selectedCount} of ${totalCount} selected`;

    if (selectedCount > 0) {
      elements.downloadActionText.textContent = `Download Selected (${selectedCount})`;
    } else {
      elements.downloadActionText.textContent = totalCount > 0 ? `Download All Materials (${totalCount})` : 'Download All Materials';
    }

    elements.downloadActionBtn.disabled = totalCount === 0;
    elements.zipActionBtn.disabled = totalCount === 0;
  }

  // --------------- Selection Actions ---------------
  function syncFileSelection(fileId, selected) {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, {
        action: 'toggleFileSelect',
        fileId,
        selected,
      }).catch(() => {});
    }
  }

  async function triggerSingleDownload(file, btn) {
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<span style="font-size:11px">⏳</span>`;
    btn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'downloadFile',
        file,
        tabId: currentTabId,
      });

      if (response?.success) {
        btn.innerHTML = `✓`;
        btn.style.color = 'var(--cd-success)';
        setTimeout(() => {
          btn.innerHTML = origHtml;
          btn.style.color = '';
          btn.disabled = false;
          loadHistory();
        }, 1500);
      } else {
        btn.innerHTML = `✗`;
        btn.style.color = 'var(--cd-error)';
        btn.title = `Error: ${response?.error || 'Download failed'}`;
        setTimeout(() => {
          btn.innerHTML = origHtml;
          btn.style.color = '';
          btn.disabled = false;
        }, 2500);
      }
    } catch (err) {
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  }

  async function triggerPdfAction(file, btn) {
    const origText = btn.textContent;
    btn.textContent = '⏳';
    btn.disabled = true;

    try {
      // 1. First attempt: Direct silent PDF download/export (no new tabs, no print dialogs)
      const response = await chrome.runtime.sendMessage({
        action: 'downloadFileAsPdf',
        file,
        tabId: currentTabId,
      });

      if (response?.success) {
        btn.textContent = '✓';
        btn.style.color = 'var(--cd-success)';
        loadHistory();
      } else {
        // 2. Fallback: If Google blocks direct conversion (e.g. view-only file), open viewer to print
        console.warn('Direct PDF export failed, trying viewer print fallback:', response?.error);
        await chrome.runtime.sendMessage({
          action: 'openAndPrintFileAsPdf',
          file,
          tabId: currentTabId,
        });
        btn.textContent = '🖨️';
        btn.style.color = 'var(--cd-primary)';
      }
    } catch (err) {
      btn.textContent = '✗';
      btn.style.color = 'var(--cd-error)';
    } finally {
      setTimeout(() => {
        btn.textContent = origText;
        btn.style.color = '';
        btn.disabled = false;
      }, 3000);
    }
  }

  // --------------- Expand All Action ---------------
  async function handleExpandAll() {
    if (!isClassroom || !currentTabId) return;
    elements.expandAllBtn.textContent = '⏳ Expanding...';

    try {
      const res = await chrome.tabs.sendMessage(currentTabId, { action: 'triggerExpandAll' });
      setTimeout(async () => {
        const info = await chrome.tabs.sendMessage(currentTabId, { action: 'getPageInfo' });
        if (info) {
          updateView(info);
        }
        elements.expandAllBtn.textContent = '📂 Expand All';
      }, 1000);
    } catch {
      elements.expandAllBtn.textContent = '📂 Expand All';
    }
  }

  // --------------- Rescan Page Action ---------------
  async function handleRescan() {
    if (!isClassroom || !currentTabId) return;
    elements.scanBtn.textContent = 'Scanning...';

    try {
      const response = await chrome.tabs.sendMessage(currentTabId, { action: 'scanPage' });
      if (response) {
        attachmentsList = response.attachments || [];
        elements.tabFilesBadge.textContent = attachmentsList.length;
        renderFilesList();
        updateSelectionUI();
      }
    } catch {}
    elements.scanBtn.textContent = '🔍 Rescan';
  }

  // --------------- Event Listeners ---------------
  function setupEventListeners() {
    // Search input
    elements.fileSearchInput.addEventListener('input', (e) => {
      filterQuery = e.target.value.trim();
      elements.searchClearBtn.classList.toggle('cd-hidden', !filterQuery);
      renderFilesList();
    });

    elements.searchClearBtn.addEventListener('click', () => {
      elements.fileSearchInput.value = '';
      filterQuery = '';
      elements.searchClearBtn.classList.add('cd-hidden');
      renderFilesList();
    });

    // Expand All Buttons
    elements.expandAllBtn?.addEventListener('click', handleExpandAll);
    elements.emptyExpandBtn?.addEventListener('click', handleExpandAll);

    // Select All
    elements.popupSelectAll.addEventListener('click', () => {
      attachmentsList.forEach(f => f.selected = true);
      renderFilesList();
      updateSelectionUI();
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { action: 'triggerSelectAll' }).catch(() => {});
      }
    });

    // Deselect All
    elements.popupDeselectAll.addEventListener('click', () => {
      attachmentsList.forEach(f => f.selected = false);
      renderFilesList();
      updateSelectionUI();
      if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { action: 'triggerDeselectAll' }).catch(() => {});
      }
    });

    // Main Download Action Button (Downloads selected or all)
    elements.downloadActionBtn.addEventListener('click', () => {
      if (!isClassroom || !currentTabId) return;

      const hasSelection = attachmentsList.some(f => f.selected);
      const action = hasSelection ? 'triggerDownloadSelected' : 'triggerDownloadAll';
      chrome.tabs.sendMessage(currentTabId, { action }).catch(() => {});
      window.close();
    });

    // Download as ZIP Button
    elements.zipActionBtn.addEventListener('click', () => {
      if (!isClassroom || !currentTabId) return;

      const hasSelection = attachmentsList.some(f => f.selected);
      const action = hasSelection ? 'triggerZipSelected' : 'triggerZipAll';
      chrome.tabs.sendMessage(currentTabId, { action }).catch(() => {});
      window.close();
    });

    // Rescan Page Button
    elements.scanBtn.addEventListener('click', handleRescan);
    elements.emptyRescanBtn?.addEventListener('click', handleRescan);

    // Print / Save Page as PDF (Ctrl+P)
    function handlePrintPdf() {
      if (!isClassroom || !currentTabId) return;
      chrome.tabs.sendMessage(currentTabId, { action: 'triggerPrintPage' }).catch(() => {});
      window.close();
    }
    elements.printPdfBtn?.addEventListener('click', handlePrintPdf);
    elements.printPdfActionBtn?.addEventListener('click', handlePrintPdf);

    // Tab Navigation
    $$('.cd-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.cd-tab').forEach(t => t.classList.remove('cd-tab-active'));
        tab.classList.add('cd-tab-active');

        const panelName = tab.dataset.tab;
        elements.filesPanel.style.display = panelName === 'files' ? 'flex' : 'none';
        elements.historyPanel.style.display = panelName === 'history' ? 'flex' : 'none';
        elements.settingsPanel.style.display = panelName === 'settings' ? 'flex' : 'none';
        if (elements.logsPanel) {
          elements.logsPanel.style.display = panelName === 'logs' ? 'flex' : 'none';
        }

        if (panelName === 'history') {
          loadHistory();
        } else if (panelName === 'logs') {
          loadLogs();
        }
      });
    });

    // Clear Logs
    elements.clearLogsBtn?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'clearDebugLogs' });
      if (elements.logsContainer) {
        elements.logsContainer.innerHTML = '<div style="color:#71717a">Logs cleared.</div>';
      }
    });

    // Clear History
    elements.clearHistoryBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ action: 'clearHistory' });
      elements.historyList.innerHTML = '<div class="cd-empty-state">No downloads yet</div>';
    });

    // Save Settings
    elements.saveSettingsBtn.addEventListener('click', saveSettings);
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

        const retryBtn = div.querySelector('.cd-history-retry');
        if (retryBtn) {
          retryBtn.addEventListener('click', async () => {
            retryBtn.textContent = '⏳';
            await chrome.runtime.sendMessage({ action: 'retryDownload', fileId: item.id });
            setTimeout(loadHistory, 1500);
          });
        }

        elements.historyList.appendChild(div);
      }
    } catch {}
  }

  // --------------- Logs Viewer ---------------
  async function loadLogs() {
    if (!elements.logsContainer) return;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getDebugLogs' });
      const logs = response?.logs || [];
      if (logs.length === 0) {
        elements.logsContainer.innerHTML = '<div style="color:#71717a">No activity logs recorded yet.</div>';
        return;
      }
      elements.logsContainer.innerHTML = logs.map(l => {
        let color = '#d4d4d4';
        if (l.level === 'error') color = '#ef4444';
        else if (l.level === 'warn') color = '#f59e0b';
        else if (l.level === 'info') color = '#60a5fa';
        return `<div style="margin-bottom:4px;color:${color}">[${l.time}] ${escapeHtml(l.text)}${l.details ? ' ' + escapeHtml(l.details) : ''}</div>`;
      }).reverse().join('');
    } catch (e) {
      elements.logsContainer.innerHTML = `<div style="color:#ef4444">Failed to load logs: ${e.message}</div>`;
    }
  }

  // --------------- Settings ---------------
  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
      const settings = response?.settings || {};

      if (settings.defaultBehavior) $('#settingBehavior').value = settings.defaultBehavior;
      if (settings.docExportFormat) $('#settingDocFormat').value = settings.docExportFormat;
      if (settings.sheetExportFormat) $('#settingSheetFormat').value = settings.sheetExportFormat;
      if (settings.slideExportFormat) $('#settingSlideFormat').value = settings.slideExportFormat;
      if (settings.maxConcurrent) $('#settingConcurrent').value = settings.maxConcurrent.toString();
      if (settings.preserveFolders !== undefined) $('#settingFolders').checked = settings.preserveFolders;
      if (settings.showNotifications !== undefined) $('#settingNotifications').checked = settings.showNotifications;
      if (settings.authOverride && settings.authOverride !== 'auto') {
        $('#settingAuthOverride').value = settings.authOverride;
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
      showNotifications: $('#settingNotifications').checked,
      authOverride: $('#settingAuthOverride').value.trim() || 'auto',
      theme: $('#settingTheme').value,
    };

    await chrome.runtime.sendMessage({ action: 'saveSettings', settings });
    applyTheme(settings.theme);

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
  }

  // --------------- Utilities ---------------
  function formatTime(timestamp) {
    if (!timestamp) return '';
    const diffMs = Date.now() - timestamp;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --------------- Run ---------------
  init();
})();

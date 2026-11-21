// ============================================================
// Classroom Downloader — Content Script
// Injected into Google Classroom pages
// ============================================================

(function () {
  'use strict';

  // Prevent double injection
  if (window.__classroomDownloaderInjected) return;
  window.__classroomDownloaderInjected = true;

  // --------------- Constants ---------------
  const MARKER = 'data-cd-processed';
  const CHECKBOX_MARKER = 'data-cd-checkbox';
  const DOWNLOAD_BTN_MARKER = 'data-cd-download-btn';

  // URL patterns for detecting file types
  const PATTERNS = {
    driveFile: /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    driveOpen: /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    driveUc: /drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/,
    googleDoc: /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    googleSheet: /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    googleSlide: /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
    googleDrawing: /docs\.google\.com\/drawings\/d\/([a-zA-Z0-9_-]+)/,
    googleForm: /docs\.google\.com\/forms\/d\/([a-zA-Z0-9_-]+)/,
    youtube: /(?:youtube\.com|youtu\.be)\//,
    externalLink: /^https?:\/\//,
  };

  // File type icons (SVG)
  const ICONS = {
    download: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    zip: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  };

  // --------------- State ---------------
  const attachments = new Map(); // id -> attachment info
  const selectedFiles = new Set();
  let floatingBar = null;
  let progressOverlay = null;
  let pageInfo = { type: 'unknown', courseName: '', topicName: '', assignmentName: '' };

  // --------------- Page Detection ---------------
  function detectPageType() {
    const url = window.location.href;
    const path = window.location.pathname;

    if (path.match(/\/c\/[^/]+\/a\/[^/]+/)) {
      pageInfo.type = 'assignment';
    } else if (path.match(/\/c\/[^/]+\/m\/[^/]+/)) {
      pageInfo.type = 'material';
    } else if (path.match(/\/w\/[^/]+/)) {
      pageInfo.type = 'classwork';
    } else if (path.match(/\/c\/[^/]+/)) {
      pageInfo.type = 'stream';
    } else if (path.match(/\/u\/\d+\/h/) || path === '/') {
      pageInfo.type = 'home';
    }

    // Try to get course name from page
    const titleEl = document.querySelector(
      '[data-course-name], .VHRMwb, h1, [role="heading"][aria-level="1"]'
    );
    if (titleEl) {
      pageInfo.courseName = titleEl.textContent?.trim() || '';
    }

    // Fallback: use document title
    if (!pageInfo.courseName) {
      const title = document.title.replace(' - Google Classroom', '').trim();
      if (title && title !== 'Google Classroom') {
        pageInfo.courseName = title;
      }
    }

    return pageInfo;
  }

  // --------------- Attachment Detection ---------------
  function parseAttachmentLink(linkEl) {
    const href = linkEl.href || linkEl.getAttribute('href') || '';
    if (!href) return null;

    let type = null;
    let fileId = null;
    let match;

    // Skip forms and YouTube
    if (PATTERNS.googleForm.test(href) || PATTERNS.youtube.test(href)) {
      return null;
    }

    if ((match = href.match(PATTERNS.driveFile))) {
      type = 'drive';
      fileId = match[1];
    } else if ((match = href.match(PATTERNS.driveOpen))) {
      type = 'drive';
      fileId = match[1];
    } else if ((match = href.match(PATTERNS.driveUc))) {
      type = 'drive';
      fileId = match[1];
    } else if ((match = href.match(PATTERNS.googleDoc))) {
      type = 'doc';
      fileId = match[1];
    } else if ((match = href.match(PATTERNS.googleSheet))) {
      type = 'sheet';
      fileId = match[1];
    } else if ((match = href.match(PATTERNS.googleSlide))) {
      type = 'slide';
      fileId = match[1];
    } else if ((match = href.match(PATTERNS.googleDrawing))) {
      type = 'drawing';
      fileId = match[1];
    } else if (PATTERNS.externalLink.test(href)) {
      // Could be a direct download link
      if (href.match(/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|png|jpe?g|gif|bmp|svg|mp[34]|wav|avi|mov|mkv|csv|txt|rtf|odt|ods|odp)(\?|$)/i)) {
        type = 'direct';
      } else {
        return null; // Skip unsupported external links
      }
    } else {
      return null;
    }

    // Extract file name from the link's text content or parent card
    let fileName = extractFileName(linkEl, type);

    const id = fileId || generateId();

    return {
      id,
      type,
      fileId,
      url: href,
      fileName,
      linkElement: linkEl,
    };
  }

  function extractFileName(linkEl, type) {
    // Try the link's own text
    let name = '';

    // Look for text content in the attachment card
    const card = linkEl.closest('[data-cd-card], [class*="material"], [class*="attachment"]') ||
                 linkEl.closest('div[role="listitem"]') ||
                 linkEl.closest('a');

    if (card) {
      // Look for title/name elements within the card
      const titleEl = card.querySelector(
        '[class*="title"], [class*="name"], .Z4BnXb, .yDSiEe, .rZXyKc'
      );
      if (titleEl) {
        name = titleEl.textContent?.trim();
      }
    }

    if (!name) {
      // Try aria-label
      name = linkEl.getAttribute('aria-label') || linkEl.title || '';
    }

    if (!name) {
      // Try inner text of the link
      const textNodes = linkEl.querySelectorAll('span, div');
      for (const node of textNodes) {
        const t = node.textContent?.trim();
        if (t && t.length > 2 && t.length < 200) {
          name = t;
          break;
        }
      }
    }

    if (!name) {
      name = linkEl.textContent?.trim()?.substring(0, 100) || '';
    }

    // Clean up the name
    name = name.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    if (!name || name.length < 2) {
      const typeNames = {
        drive: 'Drive File',
        doc: 'Google Doc',
        sheet: 'Google Sheet',
        slide: 'Google Slides',
        drawing: 'Drawing',
        direct: 'File',
      };
      name = typeNames[type] || 'File';
    }

    return name;
  }

  function getAttachmentContext(linkEl) {
    // Try to find assignment/topic context
    let assignmentName = '';
    let topicName = '';

    // Walk up to find assignment container
    let container = linkEl.closest(
      '[data-assignment-id], [data-coursework-id], [class*="assignment"]'
    );

    if (!container) {
      // Try broader selectors
      container = linkEl.closest('[data-item-id], [jsname], li, article');
    }

    if (container) {
      const headings = container.querySelectorAll(
        'h2, h3, [role="heading"], [class*="title"], .tLDEHd, .asQXV'
      );
      for (const h of headings) {
        const text = h.textContent?.trim();
        if (text && text.length > 1 && text.length < 200) {
          assignmentName = text;
          break;
        }
      }
    }

    // Try to find topic
    let topicContainer = linkEl.closest('[data-topic-id]');
    if (!topicContainer) {
      // Walk up to find section with topic heading
      let el = container || linkEl;
      for (let i = 0; i < 15 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const topicHeading = el.querySelector(
          '[data-topic-id], .YVvGBb, h2[class*="topic"], h3[class*="topic"]'
        );
        if (topicHeading) {
          topicName = topicHeading.textContent?.trim() || '';
          break;
        }
      }
    } else {
      const heading = topicContainer.querySelector('h2, h3, [role="heading"]');
      if (heading) {
        topicName = heading.textContent?.trim() || '';
      }
    }

    return {
      assignmentName: assignmentName || pageInfo.assignmentName || '',
      topicName: topicName || pageInfo.topicName || '',
      courseName: pageInfo.courseName || 'Course',
    };
  }

  // --------------- UI Injection ---------------
  function injectControls(linkEl, attachment) {
    if (linkEl.getAttribute(MARKER)) return;
    linkEl.setAttribute(MARKER, 'true');

    // Find the best parent card to append controls to
    const card = linkEl.closest('a') || linkEl;
    const wrapper = card.parentElement || card;

    // Make wrapper position relative if not already
    const style = window.getComputedStyle(wrapper);
    if (style.position === 'static') {
      wrapper.style.position = 'relative';
    }

    // Create controls container
    const controls = document.createElement('div');
    controls.className = 'cd-controls';
    controls.setAttribute('data-cd-id', attachment.id);

    // Checkbox
    const checkbox = document.createElement('label');
    checkbox.className = 'cd-checkbox-wrapper';
    checkbox.setAttribute(CHECKBOX_MARKER, 'true');
    checkbox.innerHTML = `
      <input type="checkbox" class="cd-checkbox" data-cd-file-id="${attachment.id}" />
      <span class="cd-checkbox-visual">
        <span class="cd-check-icon">${ICONS.check}</span>
      </span>
    `;
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    checkbox.querySelector('input').addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) {
        selectedFiles.add(attachment.id);
      } else {
        selectedFiles.delete(attachment.id);
      }
      updateFloatingBar();
    });

    // Download button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'cd-download-btn';
    dlBtn.setAttribute(DOWNLOAD_BTN_MARKER, 'true');
    dlBtn.innerHTML = ICONS.download;
    dlBtn.title = `Download: ${attachment.fileName}`;
    dlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      downloadSingleFile(attachment);
    });

    controls.appendChild(checkbox);
    controls.appendChild(dlBtn);

    // Insert controls
    wrapper.style.position = 'relative';
    wrapper.appendChild(controls);
  }

  // --------------- Floating Action Bar ---------------
  function createFloatingBar() {
    if (floatingBar) return;

    floatingBar = document.createElement('div');
    floatingBar.className = 'cd-floating-bar cd-hidden';
    floatingBar.innerHTML = `
      <div class="cd-floating-inner">
        <button class="cd-fab-btn cd-select-all-btn" title="Select All">
          Select All
        </button>
        <button class="cd-fab-btn cd-deselect-btn" title="Deselect All">
          Deselect All
        </button>
        <span class="cd-fab-count">Selected: 0</span>
        <button class="cd-fab-btn cd-fab-primary cd-download-selected-btn" title="Download Selected">
          ${ICONS.download} Download Selected
        </button>
        <button class="cd-fab-btn cd-zip-selected-btn" title="Download as ZIP">
          ${ICONS.zip} ZIP
        </button>
        <button class="cd-fab-btn cd-close-bar-btn" title="Close">
          ${ICONS.close}
        </button>
      </div>
    `;

    // Event listeners
    floatingBar.querySelector('.cd-select-all-btn').addEventListener('click', selectAll);
    floatingBar.querySelector('.cd-deselect-btn').addEventListener('click', deselectAll);
    floatingBar.querySelector('.cd-download-selected-btn').addEventListener('click', downloadSelected);
    floatingBar.querySelector('.cd-zip-selected-btn').addEventListener('click', zipSelected);
    floatingBar.querySelector('.cd-close-bar-btn').addEventListener('click', () => {
      deselectAll();
    });

    document.body.appendChild(floatingBar);
  }

  function updateFloatingBar() {
    if (!floatingBar) createFloatingBar();

    const count = selectedFiles.size;
    const countEl = floatingBar.querySelector('.cd-fab-count');
    countEl.textContent = `Selected: ${count}`;

    if (count > 0) {
      floatingBar.classList.remove('cd-hidden');
    } else {
      floatingBar.classList.add('cd-hidden');
    }
  }

  // --------------- Progress Overlay ---------------
  function createProgressOverlay() {
    if (progressOverlay) return progressOverlay;

    progressOverlay = document.createElement('div');
    progressOverlay.className = 'cd-progress-overlay cd-hidden';
    progressOverlay.innerHTML = `
      <div class="cd-progress-card">
        <div class="cd-progress-header">
          <h3>Downloading...</h3>
          <button class="cd-progress-close">${ICONS.close}</button>
        </div>
        <div class="cd-progress-bar-container">
          <div class="cd-progress-bar"></div>
        </div>
        <div class="cd-progress-info">
          <span class="cd-progress-status">Starting...</span>
        </div>
        <div class="cd-progress-counts">
          <span class="cd-count-completed">✓ 0 completed</span>
          <span class="cd-count-failed">✗ 0 failed</span>
          <span class="cd-count-pending">⏳ 0 pending</span>
        </div>
        <div class="cd-progress-current"></div>
      </div>
    `;

    progressOverlay.querySelector('.cd-progress-close').addEventListener('click', () => {
      progressOverlay.classList.add('cd-hidden');
    });

    document.body.appendChild(progressOverlay);
    return progressOverlay;
  }

  function updateProgress(progress) {
    if (!progressOverlay) createProgressOverlay();
    progressOverlay.classList.remove('cd-hidden');

    const { completed = 0, failed = 0, total = 0, message = '', status = '' } = progress;
    const pending = total - completed - failed;
    const pct = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;

    progressOverlay.querySelector('.cd-progress-bar').style.width = pct + '%';
    progressOverlay.querySelector('.cd-progress-status').textContent = message || `${pct}%`;
    progressOverlay.querySelector('.cd-count-completed').textContent = `✓ ${completed} completed`;
    progressOverlay.querySelector('.cd-count-failed').textContent = `✗ ${failed} failed`;
    progressOverlay.querySelector('.cd-count-pending').textContent = `⏳ ${pending} pending`;

    if (progress.fileName) {
      progressOverlay.querySelector('.cd-progress-current').textContent = progress.fileName;
    }

    if (status === 'done' || status === 'error') {
      const header = progressOverlay.querySelector('.cd-progress-header h3');
      header.textContent = status === 'done' ? 'Download Complete!' : 'Download Error';
    }
  }

  // --------------- Actions ---------------
  function selectAll() {
    attachments.forEach((att, id) => {
      selectedFiles.add(id);
      const checkbox = document.querySelector(
        `.cd-checkbox[data-cd-file-id="${id}"]`
      );
      if (checkbox) checkbox.checked = true;
    });
    updateFloatingBar();
  }

  function deselectAll() {
    selectedFiles.clear();
    document.querySelectorAll('.cd-checkbox').forEach(cb => cb.checked = false);
    updateFloatingBar();
  }

  function downloadSingleFile(attachment) {
    const context = getAttachmentContext(attachment.linkElement);
    const file = {
      ...attachment,
      folderPath: buildFolderPath(context),
      linkElement: undefined,
    };
    // Remove non-serializable properties
    delete file.linkElement;

    chrome.runtime.sendMessage({
      action: 'downloadFile',
      file,
    }, (response) => {
      if (response?.success) {
        showToast(`Downloading: ${attachment.fileName}`);
      } else {
        showToast(`Failed: ${response?.error || 'Unknown error'}`, 'error');
      }
    });
  }

  function downloadSelected() {
    const files = getSelectedFiles();
    if (files.length === 0) {
      showToast('No files selected', 'warning');
      return;
    }

    createProgressOverlay();
    updateProgress({ completed: 0, failed: 0, total: files.length, message: 'Starting downloads...' });

    chrome.runtime.sendMessage({
      action: 'downloadFiles',
      files,
    }, (response) => {
      if (response?.success) {
        showToast(`Queued ${response.queued} files for download`);
      } else {
        showToast(`Error: ${response?.error}`, 'error');
      }
    });
  }

  function zipSelected() {
    const files = getSelectedFiles();
    if (files.length === 0) {
      showToast('No files selected', 'warning');
      return;
    }

    createProgressOverlay();
    updateProgress({ completed: 0, failed: 0, total: files.length, status: 'zipping', message: 'Preparing ZIP...' });

    const courseName = sanitizeFileName(pageInfo.courseName || 'Classroom');
    const zipName = `${courseName}-materials.zip`;

    chrome.runtime.sendMessage({
      action: 'downloadAsZip',
      files,
      zipName,
      preserveFolders: true,
    }, (response) => {
      if (response?.success) {
        showToast(`ZIP created with ${response.fetched} files`);
      } else {
        showToast(`ZIP Error: ${response?.error}`, 'error');
      }
    });
  }

  function downloadAllOnPage() {
    const files = getAllFiles();
    if (files.length === 0) {
      showToast('No downloadable files found', 'warning');
      return;
    }

    createProgressOverlay();
    updateProgress({ completed: 0, failed: 0, total: files.length, message: 'Starting downloads...' });

    chrome.runtime.sendMessage({
      action: 'downloadFiles',
      files,
    }, (response) => {
      if (response?.success) {
        showToast(`Queued ${response.queued} files for download`);
      }
    });
  }

  function downloadAllAsZip() {
    const files = getAllFiles();
    if (files.length === 0) {
      showToast('No downloadable files found', 'warning');
      return;
    }

    createProgressOverlay();
    updateProgress({ completed: 0, failed: 0, total: files.length, status: 'zipping', message: 'Preparing ZIP...' });

    const courseName = sanitizeFileName(pageInfo.courseName || 'Classroom');
    const zipName = `${courseName}-all-materials.zip`;

    chrome.runtime.sendMessage({
      action: 'downloadAsZip',
      files,
      zipName,
      preserveFolders: true,
    }, (response) => {
      if (response?.success) {
        showToast(`ZIP created with ${response.fetched} files`);
      } else {
        showToast(`ZIP Error: ${response?.error}`, 'error');
      }
    });
  }

  // --------------- Helpers ---------------
  function getSelectedFiles() {
    const files = [];
    for (const id of selectedFiles) {
      const att = attachments.get(id);
      if (att) {
        const context = getAttachmentContext(att.linkElement);
        files.push({
          id: att.id,
          type: att.type,
          fileId: att.fileId,
          url: att.url,
          fileName: att.fileName,
          folderPath: buildFolderPath(context),
        });
      }
    }
    return files;
  }

  function getAllFiles() {
    const files = [];
    attachments.forEach((att, id) => {
      const context = getAttachmentContext(att.linkElement);
      files.push({
        id: att.id,
        type: att.type,
        fileId: att.fileId,
        url: att.url,
        fileName: att.fileName,
        folderPath: buildFolderPath(context),
      });
    });
    return files;
  }

  function buildFolderPath(context) {
    const parts = [];
    if (context.courseName) parts.push(sanitizeFileName(context.courseName));
    if (context.topicName) parts.push(sanitizeFileName(context.topicName));
    if (context.assignmentName) parts.push(sanitizeFileName(context.assignmentName));
    return parts.join('/') || '';
  }

  function sanitizeFileName(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled';
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  // --------------- Toast Notifications ---------------
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `cd-toast cd-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('cd-toast-visible');
    });

    setTimeout(() => {
      toast.classList.remove('cd-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // --------------- Scanner ---------------
  function scanForAttachments() {
    detectPageType();

    // Find all links on the page
    const links = document.querySelectorAll('a[href]');
    let newCount = 0;

    links.forEach(link => {
      if (link.getAttribute(MARKER)) return;

      const attachment = parseAttachmentLink(link);
      if (attachment) {
        // Check for duplicates by fileId
        let isDuplicate = false;
        if (attachment.fileId) {
          for (const [existingId, existing] of attachments) {
            if (existing.fileId === attachment.fileId && existing.url === attachment.url) {
              isDuplicate = true;
              break;
            }
          }
        }

        if (!isDuplicate) {
          attachments.set(attachment.id, attachment);
          injectControls(link, attachment);
          newCount++;
        } else {
          link.setAttribute(MARKER, 'true');
        }
      }
    });

    if (newCount > 0) {
      updateFloatingBar();
    }

    return newCount;
  }

  // --------------- Mutation Observer ---------------
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if the added node or its children contain links
              if (node.tagName === 'A' || node.querySelector?.('a[href]')) {
                shouldScan = true;
                break;
              }
            }
          }
        }
        if (shouldScan) break;
      }

      if (shouldScan) {
        // Debounce scanning
        clearTimeout(setupObserver._timer);
        setupObserver._timer = setTimeout(() => scanForAttachments(), 300);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // --------------- URL Change Detection ---------------
  function setupUrlWatcher() {
    let lastUrl = location.href;

    const checkUrl = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Page changed — re-scan after content loads
        setTimeout(() => {
          detectPageType();
          scanForAttachments();
        }, 1500);
      }
    };

    // Listen for History API changes
    const origPushState = history.pushState;
    history.pushState = function (...args) {
      origPushState.apply(this, args);
      checkUrl();
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      origReplaceState.apply(this, args);
      checkUrl();
    };

    window.addEventListener('popstate', checkUrl);

    // Also poll as fallback (some SPA changes don't trigger events)
    setInterval(checkUrl, 2000);
  }

  // --------------- Message Listener ---------------
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.action) {
        case 'downloadProgress':
          updateProgress(message.progress);
          sendResponse({ received: true });
          return false;

        case 'getPageInfo':
          detectPageType();
          sendResponse({
            pageInfo,
            attachmentCount: attachments.size,
            selectedCount: selectedFiles.size,
            attachments: getAllFiles(),
          });
          return false;

        case 'triggerDownloadAll':
          downloadAllOnPage();
          sendResponse({ success: true });
          return false;

        case 'triggerDownloadSelected':
          downloadSelected();
          sendResponse({ success: true });
          return false;

        case 'triggerZipAll':
          downloadAllAsZip();
          sendResponse({ success: true });
          return false;

        case 'triggerSelectAll':
          selectAll();
          sendResponse({ success: true });
          return false;

        case 'triggerDeselectAll':
          deselectAll();
          sendResponse({ success: true });
          return false;

        case 'scanPage':
          const count = scanForAttachments();
          sendResponse({
            newAttachments: count,
            totalAttachments: attachments.size,
          });
          return false;

        default:
          return false;
      }
    });
  }

  // --------------- Initialization ---------------
  function init() {
    detectPageType();
    createFloatingBar();
    scanForAttachments();
    setupObserver();
    setupUrlWatcher();
    setupMessageListener();

    // Re-scan periodically for lazy-loaded content
    setTimeout(() => scanForAttachments(), 2000);
    setTimeout(() => scanForAttachments(), 5000);

    console.log('[Classroom Downloader] Initialized — found', attachments.size, 'attachments');
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

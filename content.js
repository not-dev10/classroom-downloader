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

  // URL patterns supporting multi-account indices (/u/0/, /u/1/, etc.)
  const PATTERNS = {
    driveFile: /drive\.google\.com(?:\/u\/\d+)?\/file\/d\/([a-zA-Z0-9_-]+)/,
    driveOpen: /drive\.google\.com(?:\/u\/\d+)?\/open\?.*id=([a-zA-Z0-9_-]+)/,
    driveUc: /drive\.google\.com(?:\/u\/\d+)?\/uc\?.*id=([a-zA-Z0-9_-]+)/,
    driveUsercontent: /drive\.usercontent\.google\.com\/download\?.*id=([a-zA-Z0-9_-]+)/,
    googleDoc: /docs\.google\.com(?:\/u\/\d+)?\/document\/d\/([a-zA-Z0-9_-]+)/,
    googleSheet: /docs\.google\.com(?:\/u\/\d+)?\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    googleSlide: /docs\.google\.com(?:\/u\/\d+)?\/presentation\/d\/([a-zA-Z0-9_-]+)/,
    googleDrawing: /docs\.google\.com(?:\/u\/\d+)?\/drawings\/d\/([a-zA-Z0-9_-]+)/,
    googleForm: /docs\.google\.com(?:\/u\/\d+)?\/forms\/d\/([a-zA-Z0-9_-]+)/,
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

  // --------------- Multi-Account Auth Detection ---------------
  function getActiveAuthUser() {
    try {
      const uMatch = window.location.pathname.match(/\/u\/(\d+)\//);
      if (uMatch) return uMatch[1];
      const params = new URLSearchParams(window.location.search);
      const qAuth = params.get('authuser');
      if (qAuth) return qAuth;
    } catch {}
    return '0';
  }

  // --------------- Page Detection ---------------
  function detectPageType() {
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

    // Try to get course name from page DOM
    const titleEl = document.querySelector(
      '[data-course-name], .VHRMwb, h1, [role="heading"][aria-level="1"], .A657be'
    );
    if (titleEl) {
      const t = titleEl.textContent?.trim();
      if (t && t !== 'Google Classroom') {
        pageInfo.courseName = t;
      }
    }

    // Fallback: document title
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
    } else if ((match = href.match(PATTERNS.driveUsercontent))) {
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
      if (href.match(/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|png|jpe?g|gif|bmp|svg|mp[34]|wav|avi|mov|mkv|csv|txt|rtf|odt|ods|odp)(\?|$)/i)) {
        type = 'direct';
      } else {
        return null;
      }
    } else {
      return null;
    }

    // Determine authuser
    let authuser = getActiveAuthUser();
    try {
      const urlObj = new URL(href);
      const q = urlObj.searchParams.get('authuser');
      if (q) authuser = q;
      const m = urlObj.pathname.match(/\/u\/(\d+)\//);
      if (m) authuser = m[1];
    } catch {}

    const fileName = extractFileName(linkEl, type);
    const id = fileId || generateId();

    return {
      id,
      type,
      fileId,
      url: href,
      fileName,
      authuser,
      linkElement: linkEl,
    };
  }

  function extractFileName(linkEl, type) {
    let name = '';

    // 1. Check aria-label of the link or card
    const aria = linkEl.getAttribute('aria-label') || linkEl.title || '';
    if (aria) {
      // Strip common prefixes like "Attachment: ", "File: "
      name = aria.replace(/^(?:Attachment:\s*|File:\s*|Open\s*)/i, '').trim();
    }

    // 2. Look inside the attachment card element
    if (!name) {
      const card = linkEl.closest('[data-cd-card], [class*="material"], [class*="attachment"], div[role="listitem"], .QRiHXd, .e104Eb') || linkEl;
      if (card) {
        const titleEl = card.querySelector('[class*="title"], [class*="name"], .Z4BnXb, .yDSiEe, .rZXyKc, .A657be');
        if (titleEl) {
          name = titleEl.textContent?.trim() || '';
        }
      }
    }

    // 3. Look for text spans inside link
    if (!name) {
      const spans = linkEl.querySelectorAll('span, div');
      for (const s of spans) {
        const t = s.textContent?.trim();
        if (t && t.length > 2 && t.length < 150 && !t.includes('Google Drive') && !t.includes('Google Docs')) {
          name = t;
          break;
        }
      }
    }

    // 4. Link's direct text content
    if (!name) {
      name = linkEl.textContent?.trim()?.substring(0, 100) || '';
    }

    // Clean up filename: remove multiple lines, extra spaces, and Google metadata
    name = name
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b(?:Google Drive|Google Docs|Google Sheets|Google Slides|PDF|Word|PowerPoint|Excel)\b/gi, '')
      .trim();

    if (!name || name.length < 2) {
      const typeNames = {
        drive: 'Drive File',
        doc: 'Google Doc',
        sheet: 'Google Sheet',
        slide: 'Google Slides',
        drawing: 'Drawing',
        direct: 'Attachment',
      };
      name = typeNames[type] || 'Attachment';
    }

    return name;
  }

  function getAttachmentContext(linkEl) {
    let assignmentName = '';
    let topicName = '';

    if (linkEl) {
      let container = linkEl.closest(
        '[data-assignment-id], [data-coursework-id], [class*="assignment"], [class*="coursework"], [data-item-id], li[role="listitem"], article'
      );

      if (container) {
        const headings = container.querySelectorAll(
          'h2, h3, [role="heading"], [class*="title"], .tLDEHd, .asQXV, .A657be'
        );
        for (const h of headings) {
          const text = h.textContent?.trim();
          if (text && text.length > 1 && text.length < 200) {
            assignmentName = text;
            break;
          }
        }
      }

      // Topic detection
      let topicContainer = linkEl.closest('[data-topic-id]');
      if (!topicContainer) {
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
    }

    return {
      assignmentName: assignmentName || pageInfo.assignmentName || '',
      topicName: topicName || pageInfo.topicName || '',
      courseName: pageInfo.courseName || 'Classroom',
    };
  }

  // --------------- UI Injection ---------------
  function injectControls(linkEl, attachment) {
    if (linkEl.getAttribute(MARKER)) return;
    linkEl.setAttribute(MARKER, 'true');

    const card = linkEl.closest('a') || linkEl;
    const wrapper = card.parentElement || card;

    const style = window.getComputedStyle(wrapper);
    if (style.position === 'static') {
      wrapper.style.position = 'relative';
    }

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
    checkbox.addEventListener('click', (e) => e.stopPropagation());
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

    floatingBar.querySelector('.cd-select-all-btn').addEventListener('click', selectAll);
    floatingBar.querySelector('.cd-deselect-btn').addEventListener('click', deselectAll);
    floatingBar.querySelector('.cd-download-selected-btn').addEventListener('click', downloadSelected);
    floatingBar.querySelector('.cd-zip-selected-btn').addEventListener('click', zipSelected);
    floatingBar.querySelector('.cd-close-bar-btn').addEventListener('click', deselectAll);

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
    const pending = Math.max(0, total - completed - failed);
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
      header.textContent = status === 'done' ? 'Download Complete!' : 'Download Finished with Errors';
    }
  }

  // --------------- Actions ---------------
  function selectAll() {
    attachments.forEach((att, id) => {
      selectedFiles.add(id);
      const checkbox = document.querySelector(`.cd-checkbox[data-cd-file-id="${id}"]`);
      if (checkbox) checkbox.checked = true;
    });
    updateFloatingBar();
  }

  function deselectAll() {
    selectedFiles.clear();
    document.querySelectorAll('.cd-checkbox').forEach(cb => cb.checked = false);
    updateFloatingBar();
  }

  function toggleFileSelection(fileId, isSelected) {
    if (isSelected) {
      selectedFiles.add(fileId);
    } else {
      selectedFiles.delete(fileId);
    }
    const checkbox = document.querySelector(`.cd-checkbox[data-cd-file-id="${fileId}"]`);
    if (checkbox) checkbox.checked = isSelected;
    updateFloatingBar();
  }

  function downloadSingleFile(attachment) {
    const context = getAttachmentContext(attachment.linkElement);
    const file = {
      id: attachment.id,
      type: attachment.type,
      fileId: attachment.fileId,
      url: attachment.url,
      fileName: attachment.fileName,
      authuser: attachment.authuser || getActiveAuthUser(),
      folderPath: buildFolderPath(context),
    };

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
          authuser: att.authuser || getActiveAuthUser(),
          folderPath: buildFolderPath(context),
          assignmentName: context.assignmentName,
          topicName: context.topicName,
          selected: true,
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
        authuser: att.authuser || getActiveAuthUser(),
        folderPath: buildFolderPath(context),
        assignmentName: context.assignmentName,
        topicName: context.topicName,
        courseName: context.courseName,
        selected: selectedFiles.has(att.id),
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

  // --------------- In-Tab Fetch Handler ---------------
  async function fetchFileInTab(file) {
    const authuser = file.authuser || getActiveAuthUser();
    let url = file.url;

    if (file.type === 'drive' && file.fileId) {
      url = `https://drive.google.com/uc?export=download&id=${file.fileId}&authuser=${authuser}&confirm=t`;
    } else if (file.type === 'doc' && file.fileId) {
      url = `https://docs.google.com/document/d/${file.fileId}/export?format=pdf&authuser=${authuser}`;
    } else if (file.type === 'sheet' && file.fileId) {
      url = `https://docs.google.com/spreadsheets/d/${file.fileId}/export?format=xlsx&authuser=${authuser}`;
    } else if (file.type === 'slide' && file.fileId) {
      url = `https://docs.google.com/presentation/d/${file.fileId}/export/pptx?authuser=${authuser}`;
    }

    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // --------------- Toast Notifications ---------------
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `cd-toast cd-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('cd-toast-visible');
    });

    setTimeout(() => {
      toast.classList.remove('cd-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // --------------- Scanner ---------------
  function scanForAttachments() {
    detectPageType();

    // Query links and attachment elements
    const links = document.querySelectorAll(
      'a[href*="drive.google.com"], a[href*="docs.google.com"], a[href*="drive.usercontent.google.com"], a[href]'
    );
    let newCount = 0;

    links.forEach(link => {
      if (link.getAttribute(MARKER)) return;

      const attachment = parseAttachmentLink(link);
      if (attachment) {
        let isDuplicate = false;
        if (attachment.fileId) {
          for (const [existingId, existing] of attachments) {
            if (existing.fileId === attachment.fileId) {
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
    let timer = null;
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
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
        clearTimeout(timer);
        timer = setTimeout(() => scanForAttachments(), 350);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  // --------------- URL Change Detection ---------------
  function setupUrlWatcher() {
    let lastUrl = location.href;

    const checkUrl = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          detectPageType();
          scanForAttachments();
        }, 1200);
      }
    };

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
          scanForAttachments();
          sendResponse({
            pageInfo,
            attachmentCount: attachments.size,
            selectedCount: selectedFiles.size,
            attachments: getAllFiles(),
          });
          return false;

        case 'toggleFileSelect':
          toggleFileSelection(message.fileId, message.selected);
          sendResponse({ success: true, selectedCount: selectedFiles.size });
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

        case 'triggerZipSelected':
          zipSelected();
          sendResponse({ success: true });
          return false;

        case 'triggerSelectAll':
          selectAll();
          sendResponse({ success: true, selectedCount: selectedFiles.size });
          return false;

        case 'triggerDeselectAll':
          deselectAll();
          sendResponse({ success: true, selectedCount: 0 });
          return false;

        case 'downloadSingleFileById':
          const att = attachments.get(message.fileId);
          if (att) {
            downloadSingleFile(att);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'File not found on page' });
          }
          return false;

        case 'fetchFileInTab':
          fetchFileInTab(message.file)
            .then(dataUrl => sendResponse({ success: true, dataUrl }))
            .catch(err => sendResponse({ success: false, error: err.message }));
          return true; // async

        case 'scanPage':
          const count = scanForAttachments();
          sendResponse({
            newAttachments: count,
            totalAttachments: attachments.size,
            attachments: getAllFiles(),
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

    setTimeout(() => scanForAttachments(), 1500);
    setTimeout(() => scanForAttachments(), 4000);

    console.log('[Classroom Downloader] Initialized — found', attachments.size, 'attachments');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// ============================================================
// Classroom Downloader — Background Service Worker (MV3)
// ============================================================

// --------------- State ---------------
const state = {
  downloadQueue: [],
  activeDownloads: 0,
  maxConcurrent: 3,
  downloadHistory: [],
  settings: null,
};

const DEFAULT_SETTINGS = {
  defaultBehavior: 'individual',    // 'individual' | 'zip'
  docExportFormat: 'pdf',           // pdf | docx
  sheetExportFormat: 'xlsx',        // xlsx | csv | pdf
  slideExportFormat: 'pptx',        // pptx | pdf
  preserveFolders: true,
  skipDownloaded: false,
  showNotifications: true,
  maxConcurrent: 3,
  theme: 'system',                 // light | dark | system
  authOverride: 'auto',            // 'auto' | custom index or email
};

// --------------- Initialization ---------------
chrome.runtime.onInstalled.addListener(() => {
  // Create context menu
  chrome.contextMenus.create({
    id: 'classroom-download',
    title: 'Download with Classroom Downloader',
    contexts: ['link'],
    documentUrlPatterns: ['https://classroom.google.com/*'],
  });

  // Initialize settings
  chrome.storage.local.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
      state.settings = DEFAULT_SETTINGS;
    } else {
      state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
  });

  // Initialize download history
  chrome.storage.local.get('downloadHistory', (data) => {
    state.downloadHistory = data.downloadHistory || [];
  });
});

// Load settings on startup
chrome.storage.local.get(['settings', 'downloadHistory'], (data) => {
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  state.downloadHistory = data.downloadHistory || [];
  state.maxConcurrent = state.settings.maxConcurrent || 3;
});

// --------------- Context Menu ---------------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'classroom-download' && info.linkUrl) {
    let sessionAuth = '0';
    if (tab?.id) {
      try {
        const tabInfo = await chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' });
        if (tabInfo?.sessionUser?.effectiveAuth) {
          sessionAuth = tabInfo.sessionUser.effectiveAuth;
        }
      } catch { }
    }

    const fileInfo = parseLinkUrl(info.linkUrl);
    const targetFile = fileInfo || {
      url: info.linkUrl,
      fileName: extractFileNameFromUrl(info.linkUrl),
      type: 'direct',
      id: generateId(),
      authuser: sessionAuth,
    };
    if (fileInfo) {
      fileInfo.authuser = sessionAuth;
    }
    downloadFile(targetFile, tab?.id).catch(err => {
      console.error('Context menu download failed:', err);
    });
  }
});

// --------------- Message Handler ---------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'downloadFile':
      handleDownloadFile(message, sender, sendResponse);
      return true;

    case 'downloadFiles':
      handleDownloadFiles(message, sender, sendResponse);
      return true;

    case 'downloadAsZip':
      handleDownloadAsZip(message, sender, sendResponse);
      return true;

    case 'getSettings':
      sendResponse({ settings: state.settings || DEFAULT_SETTINGS });
      return false;

    case 'saveSettings':
      state.settings = { ...DEFAULT_SETTINGS, ...message.settings };
      state.maxConcurrent = state.settings.maxConcurrent || 3;
      chrome.storage.local.set({ settings: state.settings });
      sendResponse({ success: true });
      return false;

    case 'getDownloadHistory':
      sendResponse({ history: state.downloadHistory });
      return false;

    case 'clearHistory':
      state.downloadHistory = [];
      chrome.storage.local.set({ downloadHistory: [] });
      sendResponse({ success: true });
      return false;

    case 'getDebugLogs':
      chrome.storage.local.get('debugLogs', (data) => {
        sendResponse({ logs: data.debugLogs || [] });
      });
      return true;

    case 'clearDebugLogs':
      chrome.storage.local.set({ debugLogs: [] });
      sendResponse({ success: true });
      return false;

    case 'retryDownload':
      const historyItem = state.downloadHistory.find(h => h.id === message.fileId);
      if (historyItem) {
        downloadFile({
          url: historyItem.url,
          fileName: historyItem.fileName,
          type: historyItem.type,
          id: historyItem.id,
          fileId: historyItem.fileId,
          authuser: historyItem.authuser || '0',
        }, sender.tab?.id);
      }
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

// --------------- Debug Log Buffer & Forwarder ---------------
function logMsg(tabId, level, text, details = null) {
  const prefix = '[Classroom Downloader]';
  if (details !== null && details !== undefined) {
    if (console[level]) console[level](prefix, text, details);
    else console.log(prefix, text, details);
  } else {
    if (console[level]) console[level](prefix, text);
    else console.log(prefix, text);
  }

  // Save entry in storage for popup viewer
  saveDebugLog(level, text, details);

  // Relay to Classroom tab so user can see it in F12 console
  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: 'remoteLog',
      level,
      text,
      details: (typeof details === 'object' && details !== null) ? JSON.parse(JSON.stringify(details)) : details
    }).catch(() => {});
  }
}

function saveDebugLog(level, text, details) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    level,
    text,
    details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : ''
  };
  chrome.storage.local.get('debugLogs', (data) => {
    const logs = data.debugLogs || [];
    logs.push(entry);
    if (logs.length > 150) logs.shift();
    chrome.storage.local.set({ debugLogs: logs });
  });
}

// --------------- Download Handlers ---------------
async function handleDownloadFile(message, sender, sendResponse) {
  try {
    const tabId = message.tabId || sender.tab?.id;
    const result = await downloadFile(message.file, tabId);
    sendResponse({ success: true, result });
  } catch (error) {
    console.error('Download error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

async function handleDownloadFiles(message, sender, sendResponse) {
  try {
    const files = message.files || [];
    const tabId = message.tabId || sender.tab?.id;
    let completed = 0;
    let failed = 0;
    const total = files.length;
    const results = [];

    // Queue all files
    for (const file of files) {
      state.downloadQueue.push({
        file,
        tabId,
        resolve: (result) => {
          completed++;
          results.push({ ...file, status: 'completed' });
          notifyProgress(tabId, { completed, failed, total, fileName: file.fileName });
        },
        reject: (error) => {
          failed++;
          results.push({ ...file, status: 'failed', error: error.message });
          notifyProgress(tabId, { completed, failed, total, fileName: file.fileName });
        },
      });
    }

    processQueue();
    sendResponse({ success: true, queued: total });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleDownloadAsZip(message, sender, sendResponse) {
  const files = message.files || [];
  const zipName = message.zipName || 'classroom-materials.zip';
  const tabId = message.tabId || sender.tab?.id;

  try {
    notifyProgress(tabId, {
      completed: 0,
      failed: 0,
      total: files.length,
      status: 'zipping',
      message: 'Fetching materials for ZIP archive...',
    });

    const fileData = [];
    let completed = 0;
    let failed = 0;

    for (const file of files) {
      try {
        const blob = await fetchFileBlobWithFallback(file, tabId);
        const arrayBuffer = await blob.arrayBuffer();

        // Build file name with proper extension
        const finalName = buildFileName(file);
        let path = finalName;
        if (message.preserveFolders && file.folderPath) {
          path = sanitizePath(file.folderPath) + '/' + finalName;
        }

        fileData.push({ path, data: new Uint8Array(arrayBuffer) });
        completed++;
        notifyProgress(tabId, {
          completed,
          failed,
          total: files.length,
          status: 'zipping',
          message: `Fetched ${completed}/${files.length}: ${file.fileName}`,
        });
      } catch (err) {
        failed++;
        console.error(`Failed to fetch ${file.fileName} for ZIP:`, err);
        notifyProgress(tabId, {
          completed,
          failed,
          total: files.length,
          status: 'zipping',
          message: `Failed: ${file.fileName} (${err.message})`,
        });
      }
    }

    if (fileData.length === 0) {
      throw new Error('No files could be downloaded. Check your classroom permissions.');
    }

    // Create ZIP using lightweight ZIP builder
    const zipBlob = await createZipBlob(fileData);
    const dataUrl = await blobToDataUrl(zipBlob);

    chrome.downloads.download({
      url: dataUrl,
      filename: sanitizeFileName(zipName),
      saveAs: true,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        notifyProgress(tabId, {
          completed,
          failed,
          total: files.length,
          status: 'error',
          message: chrome.runtime.lastError.message,
        });
      } else {
        notifyProgress(tabId, {
          completed,
          failed,
          total: files.length,
          status: 'done',
          message: 'ZIP download completed!',
        });
        addToHistory({
          id: generateId(),
          fileName: zipName,
          type: 'zip',
          status: 'completed',
          fileCount: fileData.length,
          timestamp: Date.now(),
        });
      }
    });

    sendResponse({ success: true, fetched: fileData.length, failed });
  } catch (error) {
    notifyProgress(tabId, {
      completed: 0,
      failed: files.length,
      total: files.length,
      status: 'error',
      message: error.message,
    });
    sendResponse({ success: false, error: error.message });
  }
}

// --------------- Download Queue ---------------
function processQueue() {
  while (state.activeDownloads < state.maxConcurrent && state.downloadQueue.length > 0) {
    const item = state.downloadQueue.shift();
    state.activeDownloads++;
    executeDownload(item)
      .then(() => {
        state.activeDownloads--;
        processQueue();
      })
      .catch(() => {
        state.activeDownloads--;
        processQueue();
      });
  }
}

async function executeDownload(item) {
  try {
    await downloadFile(item.file, item.tabId);
    item.resolve?.({});
  } catch (error) {
    item.reject?.(error);
  }
}

// --------------- MIME Types & Extension Mapping ---------------
const MIME_TO_EXT = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/comma-separated-values': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};

function getExtensionFromMime(mimeType) {
  if (!mimeType) return null;
  const clean = mimeType.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[clean] || null;
}

function parseFilenameFromContentDisposition(header) {
  if (!header) return null;
  // Try RFC 5987 / 6266 UTF-8 encoded filename*
  const utf8Match = header.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]).replace(/["']/g, '').trim();
    } catch {}
  }
  // Try standard filename="..."
  const standardMatch = header.match(/filename=["']?([^"';\r\n]+)["']?/i);
  if (standardMatch) {
    return standardMatch[1].replace(/["']/g, '').trim();
  }
  return null;
}
async function fetchFileBlob(file) {
  const authuser = file.authuser !== undefined ? file.authuser : '0';
  let initialUrl = getDownloadUrl(file);

  console.group(`[CD] 📦 fetchFileBlob: "${file.fileName}"`);
  console.log(`🔗 URL: ${initialUrl}`);
  console.log(`🔑 authuser: ${authuser}`);
  console.log(`📄 type: ${file.type}, fileId: ${file.fileId}`);

  let response = await fetch(initialUrl, {
    credentials: 'include',
    headers: { 'Accept': '*/*' },
  });

  let contentType = (response.headers.get('content-type') || '').toLowerCase();
  console.log(`📥 Response: HTTP ${response.status}, Content-Type: ${contentType}, Content-Length: ${response.headers.get('content-length') || 'unknown'}`);

  if (!response.ok && response.status !== 200) {
    console.error(`❌ HTTP error: ${response.status} ${response.statusText}`);
    console.groupEnd();
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // If response is HTML, Google Drive may be showing the "virus scan warning / confirm download" page
  if (contentType.includes('text/html')) {
    const htmlText = await response.text();
    let confirmUrl = null;

    // 1. Check for form action: id="download-form"
    const formMatch = htmlText.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
    if (formMatch) {
      let action = formMatch[1].replace(/&amp;/g, '&');
      const formBody = formMatch[2];
      const params = new URLSearchParams();
      const inputRegex = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
      let m;
      while ((m = inputRegex.exec(formBody)) !== null) {
        params.set(m[1], m[2]);
      }
      if (params.toString()) {
        const sep = action.includes('?') ? '&' : '?';
        confirmUrl = `${action}${sep}${params.toString()}&authuser=${authuser}`;
      }
    }

    // 2. Check for standard confirmation token in HTML
    if (!confirmUrl && file.fileId) {
      const tokenMatch = htmlText.match(/confirm=([a-zA-Z0-9_-]+)/);
      if (tokenMatch) {
        confirmUrl = `https://drive.usercontent.google.com/download?id=${file.fileId}&export=download&confirm=${tokenMatch[1]}&authuser=${authuser}`;
      }
    }

    if (confirmUrl) {
      console.log(`[CD] 🔄 Confirm URL found, re-fetching: ${confirmUrl}`);
      response = await fetch(confirmUrl, {
        credentials: 'include',
        headers: { 'Accept': '*/*' },
      });

      contentType = (response.headers.get('content-type') || '').toLowerCase();
      console.log(`[CD] 📥 Confirm response: HTTP ${response.status}, Content-Type: ${contentType}`);
      if (contentType.includes('text/html')) {
        console.error(`[CD] ❌ Confirm response is still HTML — access denied`);
        console.groupEnd();
        throw new Error('Access forbidden (403): Google returned an HTML login or permission error page.');
      }
    } else {
      console.error(`[CD] ❌ No confirm URL found in HTML page`);
      console.groupEnd();
      throw new Error('Access forbidden (403): Google returned an HTML page instead of file content.');
    }
  }

  const blob = await response.blob();
  const cd = response.headers.get('content-disposition');
  blob.serverFilename = parseFilenameFromContentDisposition(cd);
  blob.mimeExt = getExtensionFromMime(contentType);

  console.log(`[CD] ✅ Blob received: size=${blob.size}, type=${blob.type}, serverFilename=${blob.serverFilename}, mimeExt=${blob.mimeExt}`);

  // Validate that the binary is not an HTML error document disguised with a different mime-type
  if (blob.size < 4000) {
    const sample = await blob.slice(0, 100).text();
    if (sample.toLowerCase().includes('<!doctype html') || sample.toLowerCase().includes('<html')) {
      console.error(`[CD] ❌ Small blob is actually HTML: "${sample.substring(0, 80)}..."`);
      console.groupEnd();
      throw new Error('Access forbidden: Google returned an HTML login or error page.');
    }
  }

  console.groupEnd();
  return blob;
}

// Fallback: If background fetch fails, request the tab (which runs directly inside classroom.google.com) to fetch it
async function fetchFileBlobWithFallback(file, tabId) {
  try {
    return await fetchFileBlob(file);
  } catch (err) {
    // If we have a tabId, ask the tab content script to fetch it in its authenticated DOM context
    if (tabId) {
      try {
        const tabResponse = await chrome.tabs.sendMessage(tabId, {
          action: 'fetchFileInTab',
          file,
        });
        if (tabResponse?.success && tabResponse.dataUrl) {
          const res = await fetch(tabResponse.dataUrl);
          return await res.blob();
        }
      } catch (tabErr) {
        console.warn('Tab fallback fetch failed:', tabErr);
      }
    }
    throw err;
  }
}

// --------------- Download File Function ---------------
async function downloadFile(file, tabId) {
  // Ensure tabId is available
  if (!tabId) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0]?.id) tabId = tabs[0].id;
    } catch {}
  }

  const fileName = buildFileName(file);
  const downloadIdKey = file.id || generateId();
  const isGoogleFile = file.type !== 'direct';

  logMsg(tabId, 'info', `🚀 Starting download: "${file.fileName}"`, {
    type: file.type,
    fileId: file.fileId,
    authuser: file.authuser,
    fileName,
    tabId,
  });

  // --- FOR GOOGLE FILES (Drive, Docs, Sheets, Slides, Drawings):
  // Direct chrome.downloads.download() FAILS with 403 Forbidden because Chrome's download manager
  // doesn't send Google session cookies to drive.usercontent.google.com.
  // We MUST fetch the binary data first using the authenticated tab/SW session, convert to Blob DataURL,
  // and then download the DataURL so Chrome writes the real bytes directly to disk.
  if (isGoogleFile) {
    // 1. Try Tab Fetch (Highest priority — Tab runs in classroom.google.com with active session)
    if (tabId) {
      try {
        logMsg(tabId, 'info', `📥 Attempting in-tab authenticated fetch for "${file.fileName}"...`);
        const result = await attemptTabFetchDownload(file, fileName, downloadIdKey, tabId);
        logMsg(tabId, 'info', `✅ In-tab download completed successfully!`);
        return result;
      } catch (tabErr) {
        logMsg(tabId, 'warn', `⚠️ In-tab fetch failed (${tabErr.message}), falling back to service worker fetch...`);
      }
    }

    // 2. Fallback to Service Worker credentialed fetch
    try {
      logMsg(tabId, 'info', `📥 Attempting service worker credentialed fetch for "${file.fileName}"...`);
      const result = await attemptServiceWorkerFetchDownload(file, fileName, downloadIdKey, tabId);
      logMsg(tabId, 'info', `✅ Service worker download completed successfully!`);
      return result;
    } catch (swErr) {
      const errorMsg = `Download failed for "${file.fileName}": ${swErr.message}`;
      logMsg(tabId, 'error', `❌ ${errorMsg}`);
      addToHistory({
        id: downloadIdKey, fileName: file.fileName, url: file.url,
        type: file.type, fileId: file.fileId, authuser: file.authuser,
        status: 'failed', error: errorMsg, timestamp: Date.now(),
      });
      throw new Error(errorMsg);
    }
  }

  // --- FOR DIRECT NON-GOOGLE LINKS (e.g. external PDFs, ZIPs):
  try {
    const downloadUrl = getDownloadUrl(file);
    return await attemptDirectDownload(file, fileName, downloadUrl, downloadIdKey, tabId);
  } catch (directErr) {
    logMsg(tabId, 'warn', `⚠️ Direct download failed (${directErr.message}), falling back to blob fetch...`);
    return await attemptServiceWorkerFetchDownload(file, fileName, downloadIdKey, tabId);
  }
}

// Strategy: Tab Fetch (fetch binary data in the authenticated tab context)
async function attemptTabFetchDownload(file, initialFileName, downloadIdKey, tabId) {
  const tabResponse = await chrome.tabs.sendMessage(tabId, {
    action: 'fetchFileInTab',
    file,
  });

  if (!tabResponse?.success || !tabResponse.dataUrl) {
    throw new Error(tabResponse?.error || 'Tab fetch returned no binary data');
  }

  // Refine filename using serverFilename and mimeExt returned from tab
  const fileName = buildFileName(file, tabResponse.serverFilename, tabResponse.mimeExt);

  logMsg(tabId, 'info', `💾 Tab received file data (${Math.round(tabResponse.dataUrl.length * 0.75 / 1024)} KB). Saving to disk as "${fileName}"...`);

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: tabResponse.dataUrl,
      filename: fileName,
      conflictAction: 'uniquify',
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;
        logMsg(tabId, 'error', `❌ chrome.downloads error: ${errorMsg}`);
        reject(new Error(errorMsg));
      } else {
        logMsg(tabId, 'info', `✅ Download saved! Chrome download ID: ${downloadId}`);
        addToHistory({
          id: downloadIdKey, fileName, url: file.url,
          type: file.type, fileId: file.fileId, authuser: file.authuser,
          status: 'completed', downloadId, timestamp: Date.now(),
        });
        resolve({ downloadId });
      }
    });
  });
}

// Strategy: Service Worker Fetch with credentials
async function attemptServiceWorkerFetchDownload(file, initialFileName, downloadIdKey, tabId) {
  const blob = await fetchFileBlob(file);
  const dataUrl = await blobToDataUrl(blob);

  // Refine filename using serverFilename and mimeExt from blob
  const fileName = buildFileName(file, blob.serverFilename, blob.mimeExt);

  logMsg(tabId, 'info', `💾 Service worker fetched ${blob.size} bytes. Saving to disk as "${fileName}"...`);

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: fileName,
      conflictAction: 'uniquify',
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;
        logMsg(tabId, 'error', `❌ chrome.downloads error: ${errorMsg}`);
        reject(new Error(errorMsg));
      } else {
        logMsg(tabId, 'info', `✅ Download saved! Chrome download ID: ${downloadId}`);
        addToHistory({
          id: downloadIdKey, fileName, url: file.url,
          type: file.type, fileId: file.fileId, authuser: file.authuser,
          status: 'completed', downloadId, timestamp: Date.now(),
        });
        resolve({ downloadId });
      }
    });
  });
}

// Strategy: Direct download (only for external/direct non-Google URLs)
function attemptDirectDownload(file, fileName, downloadUrl, downloadIdKey, tabId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: downloadUrl,
      filename: fileName,
      conflictAction: 'uniquify',
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const onChangedListener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.error) {
          chrome.downloads.onChanged.removeListener(onChangedListener);
          reject(new Error(`Download failed: ${delta.error.current}`));
        } else if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChangedListener);
          addToHistory({
            id: downloadIdKey, fileName: file.fileName, url: file.url,
            type: file.type, fileId: file.fileId, authuser: file.authuser,
            status: 'completed', downloadId, timestamp: Date.now(),
          });
          resolve({ downloadId });
        }
      };
      chrome.downloads.onChanged.addListener(onChangedListener);
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(onChangedListener);
        resolve({ downloadId });
      }, 30000);
    });
  });
}

// --------------- URL Builders ---------------
function getDownloadUrl(file) {
  if (!file) return '';

  const settings = state.settings || DEFAULT_SETTINGS;
  let auth = file.authuser !== undefined && file.authuser !== '' ? file.authuser : '0';

  // Apply manual user override if configured in Settings
  if (settings.authOverride && settings.authOverride !== 'auto') {
    console.log(`[CD] 🔑 getDownloadUrl: authOverride active, switching from "${auth}" to "${settings.authOverride}"`);
    auth = settings.authOverride;
  }

  const isEmail = typeof auth === 'string' && auth.includes('@');
  const authParam = encodeURIComponent(auth);
  console.log(`[CD] 🔗 getDownloadUrl: type=${file.type}, fileId=${file.fileId}, auth=${auth}, isEmail=${isEmail}`);

  switch (file.type) {
    case 'drive':
      return `https://drive.usercontent.google.com/download?id=${file.fileId}&export=download&authuser=${authParam}&confirm=t`;

    case 'doc':
      return isEmail
        ? `https://docs.google.com/document/d/${file.fileId}/export?format=${settings.docExportFormat || 'pdf'}&authuser=${authParam}`
        : `https://docs.google.com/document/u/${auth}/d/${file.fileId}/export?format=${settings.docExportFormat || 'pdf'}`;

    case 'sheet':
      return isEmail
        ? `https://docs.google.com/spreadsheets/d/${file.fileId}/export?format=${settings.sheetExportFormat || 'xlsx'}&authuser=${authParam}`
        : `https://docs.google.com/spreadsheets/u/${auth}/d/${file.fileId}/export?format=${settings.sheetExportFormat || 'xlsx'}`;

    case 'slide':
      return isEmail
        ? `https://docs.google.com/presentation/d/${file.fileId}/export/${settings.slideExportFormat || 'pptx'}?authuser=${authParam}`
        : `https://docs.google.com/presentation/u/${auth}/d/${file.fileId}/export/${settings.slideExportFormat || 'pptx'}`;

    case 'drawing':
      return isEmail
        ? `https://docs.google.com/drawings/d/${file.fileId}/export/png?authuser=${authParam}`
        : `https://docs.google.com/drawings/u/${auth}/d/${file.fileId}/export/png`;

    case 'direct':
    default:
      return file.url || '';
  }
}

function buildFileName(file, serverFilename = null, mimeExt = null) {
  const settings = state.settings || DEFAULT_SETTINGS;
  const rawName = file.fileName || 'untitled';
  let name = sanitizeFileName(rawName);

  console.log(`[CD] 🏗️ buildFileName: raw="${rawName}" → sanitized="${name}" (type=${file.type}, serverFilename=${serverFilename}, mimeExt=${mimeExt})`);

  // Check if current name already has a recognized extension
  const existingExtMatch = name.match(/\.([a-zA-Z0-9]{1,10})$/i);
  let ext = existingExtMatch ? existingExtMatch[1].toLowerCase() : null;

  // If no extension, determine the best extension from server/detected/types
  if (!ext) {
    if (serverFilename) {
      const serverMatch = serverFilename.match(/\.([a-zA-Z0-9]{1,10})$/i);
      if (serverMatch) ext = serverMatch[1].toLowerCase();
    }
    if (!ext && mimeExt) {
      ext = mimeExt.toLowerCase();
    }
    if (!ext && file.detectedExt) {
      ext = file.detectedExt.toLowerCase();
    }
    if (!ext) {
      if (file.type === 'doc') ext = (settings.docExportFormat || 'pdf').toLowerCase();
      else if (file.type === 'sheet') ext = (settings.sheetExportFormat || 'xlsx').toLowerCase();
      else if (file.type === 'slide') ext = (settings.slideExportFormat || 'pptx').toLowerCase();
      else if (file.type === 'drawing') ext = 'png';
    }

    if (ext) {
      name += '.' + ext;
      console.log(`[CD] 🏗️ buildFileName: attached extension .${ext} → "${name}"`);
    }
  }

  // Final safety: sanitize stem and extension
  const extMatch = name.match(/^(.+?)(\.[a-zA-Z0-9]{1,10})$/);
  if (extMatch) {
    let stem = extMatch[1].replace(/[.\s]+$/, '').trim() || 'untitled';
    let fileExt = extMatch[2].toLowerCase();
    name = stem + fileExt;
  } else {
    name = name.replace(/[.\s]+$/, '').trim() || 'untitled';
  }

  // Build folder path if requested
  if (settings.preserveFolders && file.folderPath) {
    const folderPath = sanitizePath(file.folderPath);
    const fullPath = folderPath ? folderPath + '/' + name : name;
    console.log(`[CD] 🏗️ buildFileName: final path="${fullPath}" (preserveFolders=true)`);
    return fullPath;
  }

  console.log(`[CD] 🏗️ buildFileName: final="${name}"`);
  return name;
}

// --------------- Minimal ZIP Implementation ---------------
async function createZipBlob(files) {
  const encoder = new TextEncoder();
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    // Local file header
    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    new Uint8Array(local, 30).set(nameBytes);

    localHeaders.push({ header: new Uint8Array(local), data, offset, crc, size, nameBytes });

    // Central directory header
    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    new Uint8Array(central, 46).set(nameBytes);

    centralHeaders.push(new Uint8Array(central));
    offset += 30 + nameBytes.length + size;
  }

  // Build the blob
  const parts = [];
  for (const lh of localHeaders) {
    parts.push(lh.header);
    parts.push(lh.data);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) {
    parts.push(ch);
    centralSize += ch.length;
  }

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);

  parts.push(new Uint8Array(eocd));

  return new Blob(parts, { type: 'application/zip' });
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = getCRC32Table();
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let _crc32Table = null;
function getCRC32Table() {
  if (_crc32Table) return _crc32Table;
  _crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crc32Table[i] = c >>> 0;
  }
  return _crc32Table;
}

// --------------- Utility Functions ---------------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function parseLinkUrl(url) {
  if (!url) return null;

  // Google Drive file
  let match = url.match(/drive\.google\.com(?:\/u\/\d+)?\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'drive',
      fileId: match[1],
      fileName: 'file',
      url: url,
      id: generateId(),
      authuser: extractAuthUserFromUrl(url),
    };
  }

  match = url.match(/drive\.google\.com(?:\/u\/\d+)?\/open\?.*id=([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'drive',
      fileId: match[1],
      fileName: 'file',
      url: url,
      id: generateId(),
      authuser: extractAuthUserFromUrl(url),
    };
  }

  // Google Doc
  match = url.match(/docs\.google\.com(?:\/u\/\d+)?\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'doc',
      fileId: match[1],
      fileName: 'document',
      url: url,
      id: generateId(),
      authuser: extractAuthUserFromUrl(url),
    };
  }

  // Google Sheet
  match = url.match(/docs\.google\.com(?:\/u\/\d+)?\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'sheet',
      fileId: match[1],
      fileName: 'spreadsheet',
      url: url,
      id: generateId(),
      authuser: extractAuthUserFromUrl(url),
    };
  }

  // Google Slide
  match = url.match(/docs\.google\.com(?:\/u\/\d+)?\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'slide',
      fileId: match[1],
      fileName: 'presentation',
      url: url,
      id: generateId(),
      authuser: extractAuthUserFromUrl(url),
    };
  }

  // Google Drawing
  match = url.match(/docs\.google\.com(?:\/u\/\d+)?\/drawings\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'drawing',
      fileId: match[1],
      fileName: 'drawing',
      url: url,
      id: generateId(),
      authuser: extractAuthUserFromUrl(url),
    };
  }

  return null;
}

function extractAuthUserFromUrl(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('authuser');
    if (q) return q;
    const m = u.pathname.match(/\/u\/(\d+)\//);
    if (m) return m[1];
  } catch { }
  return '0';
}

function extractFileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const last = parts[parts.length - 1];
    return decodeURIComponent(last) || 'download';
  } catch {
    return 'download';
  }
}

function sanitizeFileName(name) {
  let clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')  // Remove illegal chars
    .replace(/\s+/g, ' ')                      // Collapse whitespace
    .trim()
    .replace(/[.\s]+$/, '');                    // Strip trailing dots & spaces (Windows rejects these)
  // If name is empty after sanitization, use fallback
  if (!clean) {
    console.warn(`[CD] ⚠️ sanitizeFileName: "${name}" became empty after sanitization, using "untitled"`);
  }
  return clean || 'untitled';
}

function sanitizePath(path) {
  return path.split('/').map(p => sanitizeFileName(p)).filter(p => p && p !== 'untitled').join('/');
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function addToHistory(item) {
  state.downloadHistory.unshift(item);
  if (state.downloadHistory.length > 200) {
    state.downloadHistory = state.downloadHistory.slice(0, 200);
  }
  chrome.storage.local.set({ downloadHistory: state.downloadHistory });
}

function notifyProgress(tabId, progress) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: 'downloadProgress',
      progress,
    }).catch(() => { });
  }
}

// --------------- Download change listener ---------------
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state) {
    const item = state.downloadHistory.find(h => h.downloadId === delta.id);
    if (item) {
      if (delta.state.current === 'complete') {
        item.status = 'completed';
      } else if (delta.state.current === 'interrupted') {
        item.status = 'failed';
        item.error = delta.error?.current || 'Download interrupted';
      }
      chrome.storage.local.set({ downloadHistory: state.downloadHistory });
    }
  }
});

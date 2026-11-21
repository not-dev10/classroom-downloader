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
      state.settings = data.settings;
    }
  });

  // Initialize download history
  chrome.storage.local.get('downloadHistory', (data) => {
    state.downloadHistory = data.downloadHistory || [];
  });
});

// Load settings on startup
chrome.storage.local.get(['settings', 'downloadHistory'], (data) => {
  state.settings = data.settings || DEFAULT_SETTINGS;
  state.downloadHistory = data.downloadHistory || [];
  state.maxConcurrent = state.settings.maxConcurrent || 3;
});

// --------------- Context Menu ---------------
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'classroom-download' && info.linkUrl) {
    const fileInfo = parseLinkUrl(info.linkUrl);
    const targetFile = fileInfo || {
      url: info.linkUrl,
      fileName: extractFileNameFromUrl(info.linkUrl),
      type: 'direct',
      id: generateId(),
      authuser: '0',
    };
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

// --------------- Robust Blob Fetcher (for ZIP packaging) ---------------
async function fetchFileBlob(file) {
  const authuser = file.authuser !== undefined ? file.authuser : '0';
  let initialUrl = getDownloadUrl(file);

  console.log(`[Classroom Downloader ServiceWorker] 🚀 Fetching for ZIP: "${file.fileName}"`, { url: initialUrl, authuser, type: file.type });

  let response = await fetch(initialUrl, {
    credentials: 'include',
    headers: { 'Accept': '*/*' },
  });

  let contentType = (response.headers.get('content-type') || '').toLowerCase();
  console.log(`[Classroom Downloader ServiceWorker] 📥 Initial response: HTTP ${response.status}, Content-Type: ${contentType}`);

  if (!response.ok && response.status !== 200) {
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
      response = await fetch(confirmUrl, {
        credentials: 'include',
        headers: { 'Accept': '*/*' },
      });

      contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html')) {
        throw new Error('Access forbidden (403): Google returned an HTML login or permission error page.');
      }
    } else {
      throw new Error('Access forbidden (403): Google returned an HTML page instead of file content.');
    }
  }

  const blob = await response.blob();

  // Validate that the binary is not an HTML error document disguised with a different mime-type
  if (blob.size < 4000) {
    const sample = await blob.slice(0, 100).text();
    if (sample.toLowerCase().includes('<!doctype html') || sample.toLowerCase().includes('<html')) {
      throw new Error('Access forbidden: Google returned an HTML login or error page.');
    }
  }

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
  const fileName = buildFileName(file);
  const downloadIdKey = file.id || generateId();
  const downloadUrl = getDownloadUrl(file);

  console.log(`[Classroom Downloader ServiceWorker] 💾 Processing download: "${fileName}" (ID: ${downloadIdKey})`, {
    type: file.type,
    fileId: file.fileId,
    authuser: file.authuser,
    url: downloadUrl,
  });

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: downloadUrl,
        filename: fileName,
        conflictAction: 'uniquify',
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message;
          console.error(`[Classroom Downloader ServiceWorker] ❌ chrome.downloads.download error:`, errorMsg);
          addToHistory({
            id: downloadIdKey,
            fileName: file.fileName,
            url: file.url,
            type: file.type,
            fileId: file.fileId,
            authuser: file.authuser,
            status: 'failed',
            error: errorMsg,
            timestamp: Date.now(),
          });
          reject(new Error(errorMsg));
          return;
        }

        console.log(`[Classroom Downloader ServiceWorker] ✅ Download initiated (ID: ${downloadId})`);

        // Watch for completion or HTML error page detection
        const onChangedListener = (delta) => {
          if (delta.id !== downloadId) return;

          if (delta.error) {
            chrome.downloads.onChanged.removeListener(onChangedListener);
            const err = delta.error.current;
            console.error(`[Classroom Downloader ServiceWorker] Download error:`, err);
            addToHistory({
              id: downloadIdKey,
              fileName: file.fileName,
              url: file.url,
              type: file.type,
              fileId: file.fileId,
              authuser: file.authuser,
              status: 'failed',
              error: `Download failed: ${err}`,
              timestamp: Date.now(),
            });
            reject(new Error(`Download failed: ${err}`));
          } else if (delta.state && delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChangedListener);

            // Verify MIME type to ensure it isn't an HTML error/login page
            chrome.downloads.search({ id: downloadId }, (items) => {
              const item = items && items[0];
              const mime = (item?.mime || '').toLowerCase();
              const isHtml = mime.includes('text/html');

              if (isHtml && !fileName.endsWith('.html') && !fileName.endsWith('.htm')) {
                console.warn(`[Classroom Downloader] Downloaded file is HTML (auth/permission failure), removing invalid file.`);
                chrome.downloads.erase({ id: downloadId });
                const errorMsg = `Access Forbidden (403): Google returned an HTML page. Please verify your account authorization (/u/${file.authuser || '0'}/).`;
                addToHistory({
                  id: downloadIdKey,
                  fileName: file.fileName,
                  url: file.url,
                  type: file.type,
                  fileId: file.fileId,
                  authuser: file.authuser,
                  status: 'failed',
                  error: errorMsg,
                  timestamp: Date.now(),
                });
                reject(new Error(errorMsg));
              } else {
                addToHistory({
                  id: downloadIdKey,
                  fileName: file.fileName,
                  url: file.url,
                  type: file.type,
                  fileId: file.fileId,
                  authuser: file.authuser,
                  status: 'completed',
                  downloadId: downloadId,
                  timestamp: Date.now(),
                });
                resolve({ downloadId });
              }
            });
          }
        };

        chrome.downloads.onChanged.addListener(onChangedListener);

        // Fallback timeout to unregister listener after 30s
        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChangedListener);
          resolve({ downloadId });
        }, 30000);
      }
    );
  });
}

// --------------- URL Builders ---------------
function getDownloadUrl(file) {
  if (!file) return '';

  const settings = state.settings || DEFAULT_SETTINGS;
  const auth = file.authuser !== undefined ? file.authuser : '0';

  switch (file.type) {
    case 'drive':
      return `https://drive.usercontent.google.com/download?id=${file.fileId}&export=download&authuser=${auth}&confirm=t`;

    case 'doc':
      return `https://docs.google.com/document/u/${auth}/d/${file.fileId}/export?format=${settings.docExportFormat || 'pdf'}`;

    case 'sheet':
      return `https://docs.google.com/spreadsheets/u/${auth}/d/${file.fileId}/export?format=${settings.sheetExportFormat || 'xlsx'}`;

    case 'slide':
      return `https://docs.google.com/presentation/u/${auth}/d/${file.fileId}/export/${settings.slideExportFormat || 'pptx'}`;

    case 'drawing':
      return `https://docs.google.com/drawings/u/${auth}/d/${file.fileId}/export/png`;

    case 'direct':
    default:
      return file.url || '';
  }
}

function buildFileName(file) {
  const settings = state.settings || DEFAULT_SETTINGS;
  let name = sanitizeFileName(file.fileName || 'untitled');

  // Add extension if missing for exported Google Workspace files
  if (file.type === 'doc' && !name.match(/\.(pdf|docx|odt|rtf|txt|html|epub)$/i)) {
    name += '.' + (settings.docExportFormat || 'pdf');
  } else if (file.type === 'sheet' && !name.match(/\.(xlsx|csv|pdf|ods|tsv)$/i)) {
    name += '.' + (settings.sheetExportFormat || 'xlsx');
  } else if (file.type === 'slide' && !name.match(/\.(pptx|pdf|odp)$/i)) {
    name += '.' + (settings.slideExportFormat || 'pptx');
  }

  // Build folder path if requested
  if (settings.preserveFolders && file.folderPath) {
    return sanitizePath(file.folderPath) + '/' + name;
  }

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
  } catch {}
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
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'untitled';
}

function sanitizePath(path) {
  return path.split('/').map(p => sanitizeFileName(p)).join('/');
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
    }).catch(() => {});
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

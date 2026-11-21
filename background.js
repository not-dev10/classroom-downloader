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
  slideExportFormat: 'pptx',       // pptx | pdf
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
    if (fileInfo) {
      downloadFile(fileInfo);
    } else {
      // Try direct download
      downloadFile({
        url: info.linkUrl,
        fileName: extractFileNameFromUrl(info.linkUrl),
        type: 'direct',
        id: generateId(),
      });
    }
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

    case 'getPageInfo':
      // Forward to content script
      if (sender.tab) {
        sendResponse({ tabId: sender.tab.id });
      }
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
        });
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
    const result = await downloadFile(message.file);
    sendResponse({ success: true, result });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleDownloadFiles(message, sender, sendResponse) {
  try {
    const files = message.files || [];
    const tabId = sender.tab?.id;
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
  const tabId = sender.tab?.id;

  try {
    notifyProgress(tabId, {
      completed: 0,
      failed: 0,
      total: files.length,
      status: 'zipping',
      message: 'Fetching files for ZIP...',
    });

    // Fetch all files
    const fileData = [];
    let completed = 0;
    let failed = 0;

    for (const file of files) {
      try {
        const url = getDownloadUrl(file);
        const response = await fetch(url, { credentials: 'include' });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();

        // Build path
        let path = file.fileName || 'untitled';
        if (message.preserveFolders && file.folderPath) {
          path = file.folderPath + '/' + path;
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
        console.error(`Failed to fetch ${file.fileName}:`, err);
        notifyProgress(tabId, {
          completed,
          failed,
          total: files.length,
          status: 'zipping',
          message: `Failed: ${file.fileName}`,
        });
      }
    }

    if (fileData.length === 0) {
      throw new Error('No files could be fetched for ZIP');
    }

    // Create ZIP using minimal ZIP implementation (no JSZip in service worker)
    const zipBlob = await createZipBlob(fileData);
    const dataUrl = await blobToDataUrl(zipBlob);

    // Download the ZIP
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
          message: 'ZIP download started!',
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
    await downloadFile(item.file);
    item.resolve?.({});
  } catch (error) {
    item.reject?.(error);
  }
}

function downloadFile(file) {
  return new Promise((resolve, reject) => {
    const url = getDownloadUrl(file);
    const fileName = buildFileName(file);

    chrome.downloads.download(
      {
        url: url,
        filename: fileName,
        conflictAction: 'uniquify',
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          addToHistory({
            id: file.id || generateId(),
            fileName: file.fileName,
            url: url,
            type: file.type,
            fileId: file.fileId,
            status: 'failed',
            error: error,
            timestamp: Date.now(),
          });
          reject(new Error(error));
        } else {
          addToHistory({
            id: file.id || generateId(),
            fileName: file.fileName,
            url: url,
            type: file.type,
            fileId: file.fileId,
            status: 'completed',
            downloadId: downloadId,
            timestamp: Date.now(),
          });
          resolve({ downloadId });
        }
      }
    );
  });
}

// --------------- URL Builders ---------------
function getDownloadUrl(file) {
  if (!file) return '';

  const settings = state.settings || DEFAULT_SETTINGS;

  switch (file.type) {
    case 'drive':
      // Regular Drive file
      return `https://drive.google.com/uc?export=download&id=${file.fileId}&confirm=t`;

    case 'doc':
      return `https://docs.google.com/document/d/${file.fileId}/export?format=${settings.docExportFormat || 'pdf'}`;

    case 'sheet':
      return `https://docs.google.com/spreadsheets/d/${file.fileId}/export?format=${settings.sheetExportFormat || 'xlsx'}`;

    case 'slide':
      return `https://docs.google.com/presentation/d/${file.fileId}/export/${settings.slideExportFormat || 'pptx'}`;

    case 'drawing':
      return `https://docs.google.com/drawings/d/${file.fileId}/export/png`;

    case 'direct':
    default:
      return file.url || '';
  }
}

function buildFileName(file) {
  const settings = state.settings || DEFAULT_SETTINGS;
  let name = sanitizeFileName(file.fileName || 'untitled');

  // Add extension if missing for exported Google files
  if (file.type === 'doc' && !name.match(/\.(pdf|docx|odt|rtf|txt|html|epub)$/i)) {
    name += '.' + (settings.docExportFormat || 'pdf');
  } else if (file.type === 'sheet' && !name.match(/\.(xlsx|csv|pdf|ods|tsv)$/i)) {
    name += '.' + (settings.sheetExportFormat || 'xlsx');
  } else if (file.type === 'slide' && !name.match(/\.(pptx|pdf|odp)$/i)) {
    name += '.' + (settings.slideExportFormat || 'pptx');
  }

  // Build folder path
  if (settings.preserveFolders && file.folderPath) {
    return sanitizePath(file.folderPath) + '/' + name;
  }

  return name;
}

// --------------- Minimal ZIP Implementation ---------------
// A lightweight ZIP creator for service worker context (no JSZip dependency)

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
    lv.setUint32(0, 0x04034b50, true);  // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // compression (none)
    lv.setUint16(10, 0, true);           // mod time
    lv.setUint16(12, 0, true);           // mod date
    lv.setUint32(14, crc, true);         // crc32
    lv.setUint32(18, size, true);        // compressed size
    lv.setUint32(22, size, true);        // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // name length
    lv.setUint16(28, 0, true);           // extra length
    new Uint8Array(local, 30).set(nameBytes);

    localHeaders.push({ header: new Uint8Array(local), data, offset, crc, size, nameBytes });

    // Central directory header
    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true);   // signature
    cv.setUint16(4, 20, true);            // version made
    cv.setUint16(6, 20, true);            // version needed
    cv.setUint16(8, 0, true);             // flags
    cv.setUint16(10, 0, true);            // compression
    cv.setUint16(12, 0, true);            // mod time
    cv.setUint16(14, 0, true);            // mod date
    cv.setUint32(16, crc, true);          // crc32
    cv.setUint32(20, size, true);         // compressed size
    cv.setUint32(24, size, true);         // uncompressed size
    cv.setUint16(28, nameBytes.length, true); // name length
    cv.setUint16(30, 0, true);            // extra length
    cv.setUint16(32, 0, true);            // comment length
    cv.setUint16(34, 0, true);            // disk number
    cv.setUint16(36, 0, true);            // internal attrs
    cv.setUint32(38, 0, true);            // external attrs
    cv.setUint32(42, offset, true);       // local header offset
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
  ev.setUint32(0, 0x06054b50, true);       // signature
  ev.setUint16(4, 0, true);                 // disk number
  ev.setUint16(6, 0, true);                 // central dir disk
  ev.setUint16(8, files.length, true);       // entries on disk
  ev.setUint16(10, files.length, true);      // total entries
  ev.setUint32(12, centralSize, true);       // central dir size
  ev.setUint32(16, centralStart, true);      // central dir offset
  ev.setUint16(20, 0, true);                // comment length

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
  let match = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'drive',
      fileId: match[1],
      fileName: 'file',
      url: url,
      id: generateId(),
    };
  }

  match = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'drive',
      fileId: match[1],
      fileName: 'file',
      url: url,
      id: generateId(),
    };
  }

  // Google Doc
  match = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'doc',
      fileId: match[1],
      fileName: 'document',
      url: url,
      id: generateId(),
    };
  }

  // Google Sheet
  match = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'sheet',
      fileId: match[1],
      fileName: 'spreadsheet',
      url: url,
      id: generateId(),
    };
  }

  // Google Slide
  match = url.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'slide',
      fileId: match[1],
      fileName: 'presentation',
      url: url,
      id: generateId(),
    };
  }

  // Google Drawing
  match = url.match(/docs\.google\.com\/drawings\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return {
      type: 'drawing',
      fileId: match[1],
      fileName: 'drawing',
      url: url,
      id: generateId(),
    };
  }

  return null;
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
  // Keep only last 200 items
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

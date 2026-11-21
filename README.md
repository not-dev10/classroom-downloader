# Classroom Downloader

A Chrome Extension that lets you download Google Classroom materials individually, selectively, or in bulk — without manually opening every attachment.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green)

## Features

### Individual Downloads
- Download icon beside every supported attachment in Google Classroom
- One-click downloads for Drive files, PDFs, DOCX, PPTX, XLSX, images, and more
- Right-click context menu: "Download with Classroom Downloader"
- Automatic export for Google Docs → PDF/DOCX, Sheets → XLSX/CSV, Slides → PPTX/PDF

### Bulk Selection
- Checkboxes beside every attachment
- Select All / Deselect All
- Floating action bar with download count
- Select files by assignment or topic

### Download All
- Download all materials from the current page
- Progress tracking with completed/failed/pending counts
- Retry failed downloads
- Download queue with configurable concurrency

### ZIP Downloads
- Download selected files as a single ZIP archive
- Download entire course materials as ZIP
- Preserves folder structure: `Course / Topic / Assignment / file.pdf`

### Smart Integration
- MutationObserver detects dynamically loaded content
- Works with the existing Google session (no re-authentication)
- Doesn't interfere with existing Classroom functionality
- Dark/light theme support (follows system preference)

## Installation

### From Source (Developer Mode)

1. **Clone or download** this repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/classroom-downloader.git
   ```

2. Open **Google Chrome** and navigate to:
   ```
   chrome://extensions/
   ```

3. Enable **Developer Mode** (toggle in the top-right corner).

4. Click **"Load unpacked"** and select the `classroom-downloader` folder.

5. The extension icon will appear in your Chrome toolbar. Pin it for easy access.

6. Navigate to [Google Classroom](https://classroom.google.com/) and start downloading!

## Usage

### Popup
Click the extension icon to open the popup. From here you can:
- See the current course and detected materials count
- **Download All** — downloads every detected attachment
- **Select All** — checks all attachment checkboxes
- **Download Selected** — downloads only checked files
- **Download All as ZIP** — packages everything into a ZIP file
- **Rescan Page** — re-scans for newly loaded content

### In-Page Controls
On any Google Classroom page:
- **Download icon** (↓) appears on hover beside each attachment — click to download
- **Checkbox** appears on hover beside each attachment — select for bulk operations
- **Floating bar** appears at the bottom when files are selected

### Right-Click
Right-click any file link on Google Classroom → "Download with Classroom Downloader"

## Settings

Access settings from the popup's **Settings** tab:

| Setting | Options | Default |
|---------|---------|---------|
| Default download | Individual / ZIP | Individual |
| Google Docs format | PDF, DOCX, ODT, RTF, TXT | PDF |
| Google Sheets format | XLSX, CSV, PDF, ODS | XLSX |
| Google Slides format | PPTX, PDF, ODP | PPTX |
| Max concurrent downloads | 1–5 | 3 |
| Preserve folder structure | On/Off | On |
| Skip already downloaded | On/Off | Off |
| Show notifications | On/Off | On |
| Theme | System, Light, Dark | System |

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Access the current tab's content |
| `downloads` | Trigger file downloads via Chrome's download API |
| `contextMenus` | Add right-click download option |
| `storage` | Save settings and download history |
| `classroom.google.com` | Inject download controls into Classroom |
| `drive.google.com` | Download Drive-hosted files |
| `docs.google.com` | Export Google Docs/Sheets/Slides |
| `*.googleusercontent.com` | Access file thumbnails and content |

## Supported File Types

| Source | Download Format |
|--------|----------------|
| Google Drive files | Original format (PDF, DOCX, images, etc.) |
| Google Docs | PDF (default), DOCX, ODT, RTF, TXT |
| Google Sheets | XLSX (default), CSV, PDF, ODS |
| Google Slides | PPTX (default), PDF, ODP |
| Google Drawings | PNG |
| Direct links | PDF, DOCX, XLSX, PPTX, ZIP, images, media |

## Project Structure

```
classroom-downloader/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — downloads, ZIP, context menu
├── content.js             # Content script — DOM detection, UI injection
├── styles.css             # Injected styles for Classroom UI
├── popup.html             # Extension popup
├── popup.css              # Popup styles
├── popup.js               # Popup logic
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Technical Architecture

- **Manifest V3** with service worker (no persistent background page)
- **Content Script** injects UI controls into Google Classroom pages
- **MutationObserver** detects dynamically loaded attachments
- **History API** monitoring for SPA navigation changes
- **Chrome Downloads API** for reliable file downloads
- **Built-in ZIP creator** (no external library needed) — creates ZIP archives directly in the service worker
- **Chrome Storage API** for settings and download history persistence

## Known Limitations

1. **Google Forms** — Cannot be downloaded (they are interactive, not static files)
2. **YouTube links** — Skipped (not downloadable via this extension)
3. **Very large files** — ZIP creation happens in memory; extremely large course archives may exceed browser memory limits
4. **Service Worker lifetime** — MV3 service workers may terminate during very long ZIP operations; individual downloads are unaffected
5. **Google Drive large files** — Google may show a virus scan warning page for large files; the extension includes `confirm=t` to bypass when possible
6. **Obfuscated class names** — Google Classroom uses dynamically generated CSS class names; the extension uses resilient selectors but some edge cases may not be detected
7. **Rate limiting** — Google may rate-limit rapid successive downloads; the configurable concurrency limit helps avoid this
8. **Private/restricted files** — Files you don't have access to cannot be downloaded (by design — the extension respects permissions)

## Security

- Uses the existing authenticated Google session — no credentials are stored
- All file processing happens locally in the browser
- No data is sent to external servers
- Downloads only files the user has access to
- Does not bypass Google Classroom or Drive permissions

## Testing

1. Load the extension in Developer Mode
2. Navigate to [Google Classroom](https://classroom.google.com/)
3. Open a course with assignments and materials
4. Verify:
   - Download icons appear beside attachments (hover to see)
   - Checkboxes appear beside attachments
   - Individual download works (click the download icon)
   - Right-click → "Download with Classroom Downloader" works
   - Select All → Download Selected works
   - Download All downloads all visible materials
   - ZIP download creates a valid ZIP file
   - Google Docs/Sheets/Slides export correctly
   - Navigation between pages re-scans for new content
   - No duplicate controls appear
   - Existing Classroom functionality is unaffected

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License — see [LICENSE](LICENSE) for details.


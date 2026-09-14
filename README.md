# Chapter Master PDF Editor POC

A local proof of concept for turning `Chapter 37 - Now Is the Time for
Harvest.pdf` into a tracked master document. The original PDF remains
immutable; managed text fields, drafts, and named revisions are stored
separately and used to generate clean exports.

## Run locally

```bash
cd /Users/dkweon/pdf-master-editor-poc
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install
npm run prepare
npm run dev
```

Open the Vite address shown in the terminal, normally
`http://localhost:5173`.

Running `npm run dev` again is safe: the launcher reuses healthy Chapter
Master services already listening on ports 5173 and 8000. It will stop with a
clear message instead of silently choosing another port if an unrelated
process owns either port.

## Workflow

1. In **Template setup**, click one or more adjacent text lines on the same
   page.
2. Give the selection a field name. The editor automatically samples the
   original background behind the text; a manual solid-color override remains
   available for unusual regions.
3. Switch to **Edit content**, click a managed field, and revise its text.
4. Resolve any overflow warning, then enter an author and note under
   **History** and save a named revision.
5. Export the revised PDF, the PDF change log, or a complete JSON backup.

Drafts and revision history are stored in IndexedDB in the current browser.
The JSON backup is the portable master file.

### Bulleted and numbered lists

Choose **Plain text**, **Bullets**, or **Numbered** at the top of the field
editor. For a list, enter one item on each line. The preview and PDF export add
the markers and indentation automatically while keeping the text searchable.
For regular paragraphs, enable **Indent first line** to move only the opening
line inward by one standard tab.

After an edit, the page preview is rendered by the same PDF engine used for
downloaded exports. This keeps font metrics, wrapping, lists, and indentation
identical between the on-screen preview and the final PDF.

## Validation

```bash
npm test
npm run test:backend
npm run build
```

The backend test performs a real redaction and text replacement against the
six-page source PDF and verifies that the replacement remains searchable.

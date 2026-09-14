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

1. Switch to **Layout editor**, then click existing PDF text to make it
   editable. You can still use **Template setup** to group several adjacent
   PDF lines into one field.
2. Drag a selected text box to move it. Drag its lower-right handle to resize,
   use the arrow keys for precise nudging, or enter exact X, Y, width, and
   height values in the inspector.
3. Choose **Add text box**, then drag on a page to create entirely new text.
4. Edit the copy and formatting in the inspector. The editor removes managed
   source text from its original location and redraws it from the tracked box
   geometry while leaving the immutable source PDF untouched.
5. Resolve any overflow warning, then enter an author and note under
   **History** and save a named revision.
6. Export the revised PDF, the PDF change log, or a complete JSON backup.

Drafts and revision history are stored in IndexedDB in the current browser.
The JSON backup is the portable master file and includes each text box's
source, current, and revision geometry.

### Bulleted and numbered lists

Choose **Plain text**, **Bullets**, or **Numbered** at the top of the field
editor. For a list, enter one item on each line. The preview and PDF export add
the markers and indentation automatically while keeping the text searchable.
For regular paragraphs, enable **Indent first line** to move only the opening
line inward by a small paragraph-style indent.

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

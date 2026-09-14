import type {
  BoundingBox,
  Candidate,
  FieldChange,
  FieldSnapshot,
  ManagedField,
  Revision,
} from "./types";

export function unionBoxes(candidates: Candidate[]): BoundingBox {
  const left = Math.min(...candidates.map((candidate) => candidate.bbox.left));
  const top = Math.min(...candidates.map((candidate) => candidate.bbox.top));
  const right = Math.max(
    ...candidates.map(
      (candidate) => candidate.bbox.left + candidate.bbox.width,
    ),
  );
  const bottom = Math.max(
    ...candidates.map(
      (candidate) => candidate.bbox.top + candidate.bbox.height,
    ),
  );
  return { left, top, width: right - left, height: bottom - top };
}

export function sortCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (left, right) =>
      left.bbox.top - right.bbox.top || left.bbox.left - right.bbox.left,
  );
}

function normalizedFontFamily(fontFamily: string): string {
  return fontFamily.replace(/^[A-Z]{6}\+/, "").toLowerCase();
}

function startsAListItem(text: string): boolean {
  return /^\s*(?:\d+[.)]|[-\u2022])\s+/.test(text);
}

function areParagraphNeighbors(
  current: Candidate,
  next: Candidate,
): boolean {
  if (current.page !== next.page) return false;
  if (current.style.fontSize > 18 || next.style.fontSize > 18) return false;
  if (
    normalizedFontFamily(current.style.fontFamily) !==
      normalizedFontFamily(next.style.fontFamily) ||
    Math.abs(current.style.fontSize - next.style.fontSize) > 0.75 ||
    current.style.bold !== next.style.bold ||
    current.style.color !== next.style.color ||
    startsAListItem(next.text)
  ) {
    return false;
  }

  const verticalStep = next.bbox.top - current.bbox.top;
  const maximumStep =
    Math.max(current.bbox.height, next.bbox.height) * 1.45;
  if (verticalStep < -2 || verticalStep > maximumStep) return false;

  const currentRight = current.bbox.left + current.bbox.width;
  const nextRight = next.bbox.left + next.bbox.width;
  const overlap = Math.max(
    0,
    Math.min(currentRight, nextRight) -
      Math.max(current.bbox.left, next.bbox.left),
  );
  const minimumWidth = Math.min(current.bbox.width, next.bbox.width);
  const leftDifference = Math.abs(current.bbox.left - next.bbox.left);
  const horizontalGap = Math.max(
    0,
    Math.max(current.bbox.left, next.bbox.left) -
      Math.min(currentRight, nextRight),
  );

  return (
    overlap >= minimumWidth * 0.25 ||
    leftDifference <= Math.max(70, current.style.fontSize * 5) ||
    (verticalStep <= 2 &&
      horizontalGap <= Math.max(50, current.style.fontSize * 4))
  );
}

export function paragraphCandidates(
  selected: Candidate,
  candidates: Candidate[],
): Candidate[] {
  const pageCandidates = candidates.filter(
    (candidate) => candidate.page === selected.page,
  );
  if (!pageCandidates.some((candidate) => candidate.id === selected.id)) {
    return [selected];
  }

  const grouped = new Map([[selected.id, selected]]);
  let first = selected;
  let last = selected;

  while (true) {
    const previous = pageCandidates
      .filter(
        (candidate) =>
          !grouped.has(candidate.id) &&
          (candidate.bbox.top < first.bbox.top ||
            (candidate.bbox.top === first.bbox.top &&
              candidate.bbox.left < first.bbox.left)) &&
          areParagraphNeighbors(candidate, first),
      )
      .sort(
        (left, right) =>
          right.bbox.top - left.bbox.top ||
          right.bbox.left - left.bbox.left,
      )[0];
    if (!previous) break;
    grouped.set(previous.id, previous);
    first = previous;
  }

  while (true) {
    const next = pageCandidates
      .filter(
        (candidate) =>
          !grouped.has(candidate.id) &&
          (candidate.bbox.top > last.bbox.top ||
            (candidate.bbox.top === last.bbox.top &&
              candidate.bbox.left > last.bbox.left)) &&
          areParagraphNeighbors(last, candidate),
      )
      .sort(
        (left, right) =>
          left.bbox.top - right.bbox.top ||
          left.bbox.left - right.bbox.left,
      )[0];
    if (!next) break;
    grouped.set(next.id, next);
    last = next;
  }

  return sortCandidates([...grouped.values()]);
}

export function paragraphText(candidates: Candidate[]): string {
  return sortCandidates(candidates)
    .map((candidate) => candidate.text.trim())
    .filter(Boolean)
    .join(" ");
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function inferredParagraphFormat(candidates: Candidate[], bbox: BoundingBox) {
  const first = candidates[0];
  const verticalSteps = candidates
    .slice(1)
    .map((candidate, index) => candidate.bbox.top - candidates[index].bbox.top)
    .filter((step) => step > 0);
  return {
    lineHeight: verticalSteps.length
      ? Math.max(0.8, median(verticalSteps) / first.style.fontSize)
      : 1.13,
    leftIndent: 0,
    firstLineIndent: 0,
  };
}

export function createManagedField(
  candidates: Candidate[],
  label: string,
  backgroundColor: string,
): ManagedField {
  const sorted = sortCandidates(candidates);
  const first = sorted[0];
  const bbox = unionBoxes(sorted);
  const paragraph = inferredParagraphFormat(sorted, bbox);
  return {
    id: crypto.randomUUID(),
    label: label.trim(),
    page: first.page,
    candidateIds: sorted.map((candidate) => candidate.id),
    bbox,
    originalBbox: { ...bbox },
    sourceBbox: { ...bbox },
    originalText: sorted.map((candidate) => candidate.text).join("\n"),
    currentText: sorted.map((candidate) => candidate.text).join("\n"),
    fontFamily: first.style.fontFamily,
    fontSize: first.style.fontSize,
    originalFontSize: first.style.fontSize,
    bold: first.style.bold,
    color: first.style.color,
    originalColor: first.style.color,
    backgroundMode: "auto",
    backgroundColor,
    originalBackgroundColor: backgroundColor,
    align: "left",
    originalAlign: "left",
    listStyle: "none",
    originalListStyle: "none",
    firstLineTab: false,
    originalFirstLineTab: false,
    lineHeight: paragraph.lineHeight,
    originalLineHeight: paragraph.lineHeight,
    leftIndent: paragraph.leftIndent,
    originalLeftIndent: paragraph.leftIndent,
    firstLineIndent: paragraph.firstLineIndent,
    originalFirstLineIndent: paragraph.firstLineIndent,
    tabInterval: 54,
    originalTabInterval: 54,
    tabStops: [],
    originalTabStops: [],
    fitMode:
      sorted.length === 1 && first.style.fontSize >= 40 ? "shrink" : "fixed",
    previewPatch: first.previewPatch,
    previewPatchBox: first.previewPatchBox,
  };
}

function sourceSnapshot(field: ManagedField): FieldSnapshot {
  return {
    text: field.originalText,
    bbox: field.originalBbox,
    fontSize: field.originalFontSize,
    color: field.originalColor,
    backgroundMode: "auto",
    backgroundColor: field.originalBackgroundColor,
    align: field.originalAlign,
    listStyle: field.originalListStyle,
    firstLineTab: field.originalFirstLineTab,
    lineHeight: field.originalLineHeight,
    leftIndent: field.originalLeftIndent,
    firstLineIndent: field.originalFirstLineIndent,
    tabInterval: field.originalTabInterval,
    tabStops: field.originalTabStops,
  };
}

function currentSnapshot(field: ManagedField): FieldSnapshot {
  return {
    text: field.currentText,
    bbox: field.bbox,
    fontSize: field.fontSize,
    color: field.color,
    backgroundMode: field.backgroundMode,
    backgroundColor: field.backgroundColor,
    align: field.align,
    listStyle: field.listStyle,
    firstLineTab: field.firstLineTab,
    lineHeight: field.lineHeight,
    leftIndent: field.leftIndent,
    firstLineIndent: field.firstLineIndent,
    tabInterval: field.tabInterval,
    tabStops: field.tabStops,
  };
}

function styleSummary(snapshot: FieldSnapshot): string {
  const background =
    snapshot.backgroundMode === "auto"
      ? "automatic source background"
      : `background ${snapshot.backgroundColor}`;
  const stops = snapshot.tabStops.length
    ? `, tabs ${snapshot.tabStops.join("/")}`
    : "";
  const list =
    snapshot.listStyle === "none" ? "" : `, ${snapshot.listStyle} list`;
  const firstLineTab = snapshot.firstLineTab ? ", first-line tab" : "";
  const geometry = `x ${Math.round(snapshot.bbox.left)}, y ${Math.round(
    snapshot.bbox.top,
  )}, ${Math.round(snapshot.bbox.width)}×${Math.round(snapshot.bbox.height)}`;
  return `${geometry}, ${snapshot.fontSize} source units, line ${snapshot.lineHeight.toFixed(
    2,
  )}, indents ${snapshot.leftIndent}/${snapshot.firstLineIndent}${stops}${list}${firstLineTab}, ${
    snapshot.align
  }, text ${snapshot.color}, ${background}`;
}

export function insertAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): { value: string; caret: number } {
  return {
    value:
      value.slice(0, selectionStart) +
      insertion +
      value.slice(selectionEnd),
    caret: selectionStart + insertion.length,
  };
}

export function revisionChanges(
  fields: ManagedField[],
  revisions: Revision[],
): FieldChange[] {
  const priorSnapshot = revisions.at(-1)?.snapshot ?? {};
  return fields.flatMap((field) => {
    const before = priorSnapshot[field.id] ?? sourceSnapshot(field);
    const after = currentSnapshot(field);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return [];
    }
    return [
      {
        fieldId: field.id,
        label: field.label,
        before: before.text,
        after: after.text,
        beforeStyle: styleSummary(before),
        afterStyle: styleSummary(after),
      },
    ];
  });
}

export function snapshotFields(
  fields: ManagedField[],
): Record<string, FieldSnapshot> {
  return Object.fromEntries(
    fields.map((field) => [field.id, currentSnapshot(field)]),
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function responseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    return payload.detail ?? `Export failed (${response.status}).`;
  } catch {
    return `Export failed (${response.status}).`;
  }
}

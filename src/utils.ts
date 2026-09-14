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

export function candidatesInsideMarquee(
  candidates: Candidate[],
  marquee: BoundingBox,
): string[] {
  const marqueeRight = marquee.left + marquee.width;
  const marqueeBottom = marquee.top + marquee.height;
  return candidates
    .filter((candidate) => {
      const candidateRight = candidate.bbox.left + candidate.bbox.width;
      const candidateBottom = candidate.bbox.top + candidate.bbox.height;
      const intersectionWidth = Math.max(
        0,
        Math.min(marqueeRight, candidateRight) -
          Math.max(marquee.left, candidate.bbox.left),
      );
      const intersectionHeight = Math.max(
        0,
        Math.min(marqueeBottom, candidateBottom) -
          Math.max(marquee.top, candidate.bbox.top),
      );
      const candidateArea = candidate.bbox.width * candidate.bbox.height;
      return (
        candidateArea > 0 &&
        (intersectionWidth * intersectionHeight) / candidateArea >= 0.2
      );
    })
    .map((candidate) => candidate.id);
}

export function sortCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(
    (left, right) =>
      left.bbox.top - right.bbox.top || left.bbox.left - right.bbox.left,
  );
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
  const subsequent = candidates.slice(1);
  const baselineLeft = subsequent.length
    ? median(subsequent.map((candidate) => candidate.bbox.left))
    : first.bbox.left;
  const verticalSteps = candidates
    .slice(1)
    .map((candidate, index) => candidate.bbox.top - candidates[index].bbox.top)
    .filter((step) => step > 0);
  return {
    lineHeight: verticalSteps.length
      ? Math.max(0.8, median(verticalSteps) / first.style.fontSize)
      : 1.13,
    leftIndent: Math.max(0, baselineLeft - bbox.left),
    firstLineIndent: first.bbox.left - baselineLeft,
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
    fontSize: field.originalFontSize,
    color: field.originalColor,
    backgroundMode: "auto",
    backgroundColor: field.originalBackgroundColor,
    align: field.originalAlign,
    listStyle: field.originalListStyle,
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
    fontSize: field.fontSize,
    color: field.color,
    backgroundMode: field.backgroundMode,
    backgroundColor: field.backgroundColor,
    align: field.align,
    listStyle: field.listStyle,
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
  return `${snapshot.fontSize} source units, line ${snapshot.lineHeight.toFixed(
    2,
  )}, indents ${snapshot.leftIndent}/${snapshot.firstLineIndent}${stops}${list}, ${
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

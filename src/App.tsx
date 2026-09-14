import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  Clock3,
  Download,
  FileClock,
  FileDown,
  FileJson,
  FilePenLine,
  History,
  Layers3,
  List,
  ListOrdered,
  LoaderCircle,
  Move,
  PanelRight,
  RotateCcw,
  Save,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { loadState, saveState } from "./db";
import type {
  BoundingBox,
  Candidate,
  FieldSnapshot,
  ManagedField,
  MasterDocument,
  PageDefinition,
  PersistedState,
  Revision,
  SourceManifest,
} from "./types";
import {
  candidateParagraphGroups,
  createManagedField,
  downloadBlob,
  insertAtSelection,
  paragraphText,
  unionBoxes,
  responseError,
  revisionChanges,
  slugify,
  snapshotFields,
} from "./utils";

type InspectorTab = "field" | "history";
const FIRST_LINE_TAB_EM = 2.5;
const UNDO_GROUP_DELAY_MS = 450;
const MAX_UNDO_STEPS = 50;

interface UndoSnapshot {
  fields: ManagedField[];
  revisions: Revision[];
}

function createUndoSnapshot(
  fields: ManagedField[],
  revisions: Revision[],
): { snapshot: UndoSnapshot; signature: string } {
  const signature = JSON.stringify({ fields, revisions });
  return {
    snapshot: JSON.parse(signature) as UndoSnapshot,
    signature,
  };
}

interface PageCanvasProps {
  page: PageDefinition;
  previewImage?: string;
  createBoxMode: boolean;
  candidates: Candidate[];
  fields: ManagedField[];
  selectedFieldId: string | null;
  onDirectCandidateClick: (candidates: Candidate[]) => void;
  onCreateTextBox: (bbox: BoundingBox) => void;
  onFieldClick: (field: ManagedField) => void;
  onClearFieldSelection: () => void;
  onFieldTextChange: (fieldId: string, text: string) => void;
  onFieldGeometryChange: (fieldId: string, bbox: BoundingBox) => void;
  onOverflow: (fieldId: string, overflowing: boolean) => void;
}

function boxesEqual(left: BoundingBox, right: BoundingBox): boolean {
  return (
    Math.abs(left.left - right.left) < 0.01 &&
    Math.abs(left.top - right.top) < 0.01 &&
    Math.abs(left.width - right.width) < 0.01 &&
    Math.abs(left.height - right.height) < 0.01
  );
}

function fieldWasChanged(field: ManagedField): boolean {
  return (
    field.currentText !== field.originalText ||
    Math.abs(field.fontSize - field.originalFontSize) > 0.01 ||
    field.color !== field.originalColor ||
    field.backgroundMode !== "auto" ||
    field.backgroundColor !== field.originalBackgroundColor ||
    field.align !== field.originalAlign ||
    field.listStyle !== field.originalListStyle ||
    field.firstLineTab !== field.originalFirstLineTab ||
    !boxesEqual(field.bbox, field.originalBbox) ||
    Math.abs(field.lineHeight - field.originalLineHeight) > 0.001 ||
    Math.abs(field.leftIndent - field.originalLeftIndent) > 0.01 ||
    Math.abs(field.firstLineIndent - field.originalFirstLineIndent) > 0.01 ||
    Math.abs(field.tabInterval - field.originalTabInterval) > 0.01 ||
    JSON.stringify(field.tabStops) !== JSON.stringify(field.originalTabStops)
  );
}

function fontStack(family: string): string {
  if (family.toLowerCase().includes("superclarendon")) {
    return '"SuperClarendon", Georgia, serif';
  }
  if (family.toLowerCase().includes("jeju")) {
    return 'Georgia, "Times New Roman", serif';
  }
  return '"Times New Roman", Times, serif';
}

function normalizeField(field: ManagedField): ManagedField {
  const lineHeight = field.lineHeight ?? 1.13;
  // Older versions inferred these values from PDF line coordinates. That
  // inference could treat small source alignment differences as a paragraph
  // indent. Keep hidden legacy indentation neutral; the explicit first-line
  // toggle below is now the only automatic paragraph indent.
  const leftIndent = 0;
  const firstLineIndent = 0;
  const tabInterval = field.tabInterval ?? 54;
  const tabStops = Array.isArray(field.tabStops) ? field.tabStops : [];
  const listStyle = field.listStyle ?? "none";
  const firstLineTab = field.firstLineTab ?? false;
  const originalBbox = field.originalBbox ?? field.bbox;
  const sourceBbox =
    field.sourceBbox === undefined
      ? field.candidateIds.length && field.originalText
        ? originalBbox
        : null
      : field.sourceBbox;
  return {
    ...field,
    bbox: { ...field.bbox },
    originalBbox: { ...originalBbox },
    sourceBbox: sourceBbox ? { ...sourceBbox } : null,
    originalColor: field.originalColor ?? field.color,
    backgroundMode: field.backgroundMode ?? "auto",
    originalBackgroundColor:
      field.originalBackgroundColor ?? field.backgroundColor ?? "#ffffff",
    originalAlign: field.originalAlign ?? field.align ?? "left",
    listStyle,
    originalListStyle: field.originalListStyle ?? listStyle,
    firstLineTab,
    originalFirstLineTab: field.originalFirstLineTab ?? firstLineTab,
    lineHeight,
    originalLineHeight: field.originalLineHeight ?? lineHeight,
    leftIndent,
    originalLeftIndent: 0,
    firstLineIndent,
    originalFirstLineIndent: 0,
    tabInterval,
    originalTabInterval: field.originalTabInterval ?? tabInterval,
    tabStops,
    originalTabStops: Array.isArray(field.originalTabStops)
      ? field.originalTabStops
      : tabStops,
    fitMode:
      field.fitMode ??
      (field.originalFontSize >= 40 && !field.originalText.includes("\n")
        ? "shrink"
        : "fixed"),
    previewPatch:
      field.previewPatch ??
      (field.candidateIds.includes("p1-t1")
        ? "/source/patch-p1-t1.png"
        : undefined),
    previewPatchBox:
      field.previewPatchBox ??
      (field.candidateIds.includes("p1-t1")
        ? { left: 49, top: 31, width: 73, height: 116 }
        : undefined),
  };
}

function snapshotFromField(field: ManagedField, text: string): FieldSnapshot {
  return {
    text,
    bbox: { ...field.bbox },
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

function normalizeRevision(
  revision: Revision,
  normalizedFields: ManagedField[],
): Revision {
  const rawSnapshot = revision.snapshot as unknown as Record<
    string,
    string | FieldSnapshot
  >;
  const snapshot = Object.fromEntries(
    Object.entries(rawSnapshot).map(([fieldId, value]) => {
      const field = normalizedFields.find((item) => item.id === fieldId);
      if (typeof value !== "string") {
        return [
          fieldId,
          {
            ...value,
            bbox: value.bbox ?? field?.originalBbox ?? {
              left: 0,
              top: 0,
              width: 100,
              height: 30,
            },
            backgroundMode: value.backgroundMode ?? "auto",
            listStyle: value.listStyle ?? "none",
            firstLineTab: value.firstLineTab ?? false,
            lineHeight: value.lineHeight ?? 1.13,
            leftIndent: 0,
            firstLineIndent: 0,
            tabInterval: value.tabInterval ?? 54,
            tabStops: Array.isArray(value.tabStops) ? value.tabStops : [],
          },
        ];
      }
      return [
        fieldId,
        field
          ? {
              ...snapshotFromField(field, value),
              bbox: { ...field.originalBbox },
            }
          : {
              text: value,
              bbox: { left: 0, top: 0, width: 100, height: 30 },
              fontSize: 12,
              color: "#000000",
              backgroundMode: "auto" as const,
              backgroundColor: "#ffffff",
              align: "left" as const,
              listStyle: "none" as const,
              firstLineTab: false,
              lineHeight: 1.13,
              leftIndent: 0,
              firstLineIndent: 0,
              tabInterval: 54,
              tabStops: [],
            },
      ];
    }),
  );
  return {
    ...revision,
    snapshot,
    changes: revision.changes.map((change) => ({
      ...change,
      beforeStyle: change.beforeStyle ?? "Source formatting",
      afterStyle: change.afterStyle ?? "Source formatting",
    })),
  };
}

function sampledBackground(
  context: CanvasRenderingContext2D,
  page: PageDefinition,
  bbox: BoundingBox,
): string {
  const x0 = Math.max(0, Math.round(bbox.left));
  const y0 = Math.max(0, Math.round(bbox.top));
  const x1 = Math.min(page.width - 1, Math.round(bbox.left + bbox.width));
  const y1 = Math.min(page.height - 1, Math.round(bbox.top + bbox.height));
  const samples: number[][] = [];
  const padding = 4;
  const thickness = 2;

  function addPixel(x: number, y: number) {
    if (x < 0 || y < 0 || x >= page.width || y >= page.height) return;
    const pixel = context.getImageData(x, y, 1, 1).data;
    samples.push([
      Math.round(pixel[0] / 4) * 4,
      Math.round(pixel[1] / 4) * 4,
      Math.round(pixel[2] / 4) * 4,
    ]);
  }

  for (let x = x0; x <= x1; x += 2) {
    for (let y = y0 - padding; y <= y0 - thickness; y += 1)
      addPixel(x, y);
    for (let y = y1 + thickness; y <= y1 + padding; y += 1)
      addPixel(x, y);
  }
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0 - padding; x <= x0 - thickness; x += 1)
      addPixel(x, y);
    for (let x = x1 + thickness; x <= x1 + padding; x += 1)
      addPixel(x, y);
  }

  const counts = new Map<string, number>();
  for (const sample of samples) {
    const key = sample.join(",");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const winner = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!winner) return "#ffffff";
  const [red, green, blue] = winner[0].split(",").map(Number);
  return `#${[red, green, blue]
    .map((value) => Math.min(value, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function previewHorizontalScale(field: ManagedField, scale: number): number {
  const baseSize = field.fontSize * scale;
  if (
    field.fitMode !== "shrink" ||
    field.currentText.includes("\n") ||
    field.listStyle !== "none" ||
    field.firstLineTab
  ) {
    return 1;
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return 1;
  context.font = `${field.bold ? 700 : 400} ${baseSize}px ${fontStack(
    field.fontFamily,
  )}`;
  const measuredWidth = Math.max(
    context.measureText(field.currentText || " ").width,
    1,
  );
  const availableWidth = field.bbox.width * scale;
  return Math.max(0.01, Math.min(1, availableWidth / measuredWidth));
}

function nextTabStop(field: ManagedField, currentX: number): number {
  const customStop = [...field.tabStops]
    .sort((left, right) => left - right)
    .find((stop) => stop > currentX + 0.5);
  if (customStop !== undefined) return customStop;
  const interval = Math.max(6, field.tabInterval);
  return Math.max(interval, Math.floor(currentX / interval + 1) * interval);
}

function TabbedText({
  field,
  scale,
}: {
  field: ManagedField;
  scale: number;
}) {
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    context.font = `${field.bold ? 700 : 400} ${field.fontSize}px ${fontStack(
      field.fontFamily,
    )}`;
  }
  return field.currentText.split("\n").map((line, lineIndex) => {
    let currentX =
      (field.firstLineTab ? 0 : field.leftIndent) +
      (lineIndex === 0
        ? field.firstLineTab
          ? field.fontSize * FIRST_LINE_TAB_EM
          : field.firstLineIndent
        : 0);
    const segments = line.split("\t").map((text, segmentIndex) => {
      if (segmentIndex > 0) currentX = nextTabStop(field, currentX);
      const left = currentX;
      currentX += context?.measureText(text).width ?? text.length * field.fontSize * 0.5;
      return { left, text };
    });
    return (
      <div
        className="tabbed-line"
        key={`${lineIndex}-${line}`}
        style={{ height: `${field.fontSize * field.lineHeight * scale}px` }}
      >
        {segments.map((segment, segmentIndex) => (
          <span
            key={`${segmentIndex}-${segment.left}`}
            style={{ left: `${segment.left * scale}px` }}
          >
            {segment.text || "\u00a0"}
          </span>
        ))}
      </div>
    );
  });
}

function ManagedList({
  field,
  scale,
}: {
  field: ManagedField;
  scale: number;
}) {
  let itemNumber = 0;
  return (
    <div className="managed-list">
      {field.currentText.split("\n").map((item, lineIndex) => {
        if (!item.trim()) {
          return (
            <div
              className="managed-list-spacer"
              key={`space-${lineIndex}`}
              style={{
                height: `${field.fontSize * field.lineHeight * scale}px`,
              }}
              aria-hidden="true"
            />
          );
        }
        itemNumber += 1;
        return (
          <div className="managed-list-item" key={`${lineIndex}-${item}`}>
            <span className="managed-list-marker">
              {field.listStyle === "bullet" ? "\u2022" : `${itemNumber}.`}
            </span>
            <span>{item}</span>
          </div>
        );
      })}
    </div>
  );
}

function ManagedOverlay({
  field,
  page,
  scale,
  selected,
  onClick,
  onOverflow,
  resolvedBackground,
  renderTextPreview,
  onTextChange,
  onGeometryChange,
}: {
  field: ManagedField;
  page: PageDefinition;
  scale: number;
  selected: boolean;
  onClick: () => void;
  onOverflow: (overflowing: boolean) => void;
  resolvedBackground: string;
  renderTextPreview: boolean;
  onTextChange: (text: string) => void;
  onGeometryChange: (bbox: BoundingBox) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const inlineEditorRef = useRef<HTMLTextAreaElement>(null);
  const geometryGesture = useRef<{
    kind: "move" | "resize";
    clientX: number;
    clientY: number;
    bbox: BoundingBox;
  } | null>(null);
  const horizontalScale = previewHorizontalScale(field, scale);
  const autoFit =
    field.fitMode === "shrink" &&
    !field.currentText.includes("\n") &&
    field.listStyle === "none" &&
    !field.firstLineTab;
  const changed = fieldWasChanged(field);
  const hasTabs = field.currentText.includes("\t");
  const hasList = field.listStyle !== "none";
  const showInlineEditor = selected;

  useLayoutEffect(() => {
    if (!showInlineEditor) return;
    const editor = inlineEditorRef.current;
    if (!editor) return;
    editor.focus();
    const caret = editor.value.length;
    editor.setSelectionRange(caret, caret);
  }, [field.id, showInlineEditor]);

  useLayoutEffect(() => {
    const element = showInlineEditor
      ? inlineEditorRef.current
      : contentRef.current;
    if (
      !element ||
      !changed ||
      (!renderTextPreview && !showInlineEditor)
    ) {
      onOverflow(false);
      return;
    }
    const belowMinimum = autoFit && horizontalScale < 0.55;
    onOverflow(
      belowMinimum ||
        element.scrollHeight > element.clientHeight + 2 ||
        (!autoFit && element.scrollWidth > element.clientWidth + 2),
    );
  }, [
    autoFit,
    changed,
    field.currentText,
    field.fontSize,
    field.listStyle,
    field.firstLineTab,
    field.lineHeight,
    field.leftIndent,
    field.firstLineIndent,
    field.tabInterval,
    field.tabStops,
    horizontalScale,
    scale,
    onOverflow,
    renderTextPreview,
    showInlineEditor,
  ]);

  const position = {
    left: `${(field.bbox.left / page.width) * 100}%`,
    top: `${(field.bbox.top / page.height) * 100}%`,
    width: `${(field.bbox.width / page.width) * 100}%`,
    height: `${(field.bbox.height / page.height) * 100}%`,
  };
  const patchPosition =
    field.previewPatch && field.previewPatchBox
      ? {
          left: `${
            ((field.previewPatchBox.left - field.bbox.left) /
              field.bbox.width) *
            100
          }%`,
          top: `${
            ((field.previewPatchBox.top - field.bbox.top) /
              field.bbox.height) *
            100
          }%`,
          width: `${(field.previewPatchBox.width / field.bbox.width) * 100}%`,
          height: `${(field.previewPatchBox.height / field.bbox.height) * 100}%`,
        }
      : undefined;

  function startGeometryGesture(
    event: React.PointerEvent<HTMLButtonElement>,
    kind: "move" | "resize",
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onClick();
    geometryGesture.current = {
      kind,
      clientX: event.clientX,
      clientY: event.clientY,
      bbox: { ...field.bbox },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateGeometry(event: React.PointerEvent<HTMLButtonElement>) {
    const gesture = geometryGesture.current;
    if (!gesture) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = (event.clientX - gesture.clientX) / Math.max(scale, 0.01);
    const deltaY = (event.clientY - gesture.clientY) / Math.max(scale, 0.01);
    if (gesture.kind === "move") {
      onGeometryChange({
        ...gesture.bbox,
        left: Math.max(
          0,
          Math.min(page.width - gesture.bbox.width, gesture.bbox.left + deltaX),
        ),
        top: Math.max(
          0,
          Math.min(page.height - gesture.bbox.height, gesture.bbox.top + deltaY),
        ),
      });
      return;
    }
    onGeometryChange({
      ...gesture.bbox,
      width: Math.max(
        24,
        Math.min(page.width - gesture.bbox.left, gesture.bbox.width + deltaX),
      ),
      height: Math.max(
        Math.max(18, field.fontSize * field.lineHeight),
        Math.min(page.height - gesture.bbox.top, gesture.bbox.height + deltaY),
      ),
    });
  }

  function finishGeometry(event: React.PointerEvent<HTMLButtonElement>) {
    if (!geometryGesture.current) return;
    geometryGesture.current = null;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      className={`managed-overlay ${selected ? "is-selected" : ""} ${
        changed ? "is-changed" : ""
      } ${field.previewPatch ? "has-artwork-patch" : ""} ${
        showInlineEditor ? "is-inline-editing" : ""
      }`}
      style={position}
    >
      {field.previewPatch &&
        patchPosition &&
        ((changed && renderTextPreview) || showInlineEditor) && (
          <img
            className="artwork-preview-patch"
            src={field.previewPatch}
            alt=""
            style={patchPosition}
          />
        )}
      {changed && renderTextPreview && !showInlineEditor && (
        <div
          ref={contentRef}
          className="managed-render"
          style={{
            backgroundColor: field.previewPatch
              ? "transparent"
              : resolvedBackground,
            color: field.color,
            fontFamily: fontStack(field.fontFamily),
            fontSize: `${field.fontSize * scale}px`,
            fontWeight: field.bold ? 700 : 400,
            lineHeight: field.lineHeight,
            textAlign: hasTabs || hasList ? "left" : field.align,
            whiteSpace:
              autoFit || hasTabs ? "nowrap" : hasList ? "normal" : "pre-wrap",
            paddingLeft:
              hasTabs || hasList || field.firstLineTab
                ? 0
                : `${field.leftIndent * scale}px`,
            textIndent: hasTabs || hasList
              ? 0
              : `${
                  (field.firstLineTab
                    ? field.fontSize * FIRST_LINE_TAB_EM
                    : field.firstLineIndent) * scale
                }px`,
            tabSize: `${field.tabInterval * scale}px`,
            right: autoFit ? "auto" : 0,
            width: autoFit ? `${100 / horizontalScale}%` : "auto",
            transform: autoFit ? `scaleX(${horizontalScale})` : undefined,
            transformOrigin:
              field.align === "right"
                ? "right top"
                : field.align === "center"
                  ? "center top"
                  : "left top",
            textShadow: field.previewPatch
              ? "0 1px 2px rgba(86, 130, 148, 0.55), 0 3px 5px rgba(86, 130, 148, 0.3)"
              : undefined,
          }}
        >
          {hasList ? (
            <ManagedList field={field} scale={scale} />
          ) : hasTabs ? (
            <TabbedText field={field} scale={scale} />
          ) : (
            field.currentText
          )}
        </div>
      )}
      {showInlineEditor && (
        <textarea
          ref={inlineEditorRef}
          className="inline-text-editor"
          value={field.currentText}
          placeholder="Type directly on the PDF..."
          spellCheck
          onChange={(event) => onTextChange(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key !== "Tab") return;
            event.preventDefault();
            const result = insertAtSelection(
              field.currentText,
              event.currentTarget.selectionStart,
              event.currentTarget.selectionEnd,
              "\t",
            );
            onTextChange(result.value);
            window.requestAnimationFrame(() => {
              inlineEditorRef.current?.setSelectionRange(
                result.caret,
                result.caret,
              );
            });
          }}
          style={{
            backgroundColor:
              field.previewPatch &&
              boxesEqual(field.bbox, field.originalBbox)
                ? "transparent"
                : resolvedBackground,
            color: field.color,
            fontFamily: fontStack(field.fontFamily),
            fontSize: `${field.fontSize * scale}px`,
            fontWeight: field.bold ? 700 : 400,
            lineHeight: field.lineHeight,
            textAlign: hasTabs || hasList ? "left" : field.align,
            paddingLeft:
              hasTabs || hasList || field.firstLineTab
                ? 0
                : `${field.leftIndent * scale}px`,
            textIndent: hasTabs || hasList
              ? 0
              : `${
                  (field.firstLineTab
                    ? field.fontSize * FIRST_LINE_TAB_EM
                    : field.firstLineIndent) * scale
                }px`,
            tabSize: `${field.tabInterval * scale}px`,
          }}
        />
      )}
      {!showInlineEditor && (
        <button
          type="button"
          className="managed-hitbox"
          onClick={onClick}
          aria-label={`Edit ${field.label}`}
          title={field.label}
        >
          <span>{field.label}</span>
        </button>
      )}
      {showInlineEditor && (
        <>
          <button
            type="button"
            className="move-handle"
            aria-label={`Move ${field.label}`}
            title="Drag to move; arrow keys nudge"
            onPointerDown={(event) => startGeometryGesture(event, "move")}
            onPointerMove={updateGeometry}
            onPointerUp={finishGeometry}
            onPointerCancel={finishGeometry}
            onKeyDown={(event) => {
              if (!event.key.startsWith("Arrow")) return;
              event.preventDefault();
              const step = event.shiftKey ? 10 : 1;
              const next = { ...field.bbox };
              if (event.key === "ArrowLeft") next.left -= step;
              if (event.key === "ArrowRight") next.left += step;
              if (event.key === "ArrowUp") next.top -= step;
              if (event.key === "ArrowDown") next.top += step;
              next.left = Math.max(
                0,
                Math.min(page.width - next.width, next.left),
              );
              next.top = Math.max(
                0,
                Math.min(page.height - next.height, next.top),
              );
              onGeometryChange(next);
            }}
          >
            <Move />
            <span>Move</span>
          </button>
          <button
            type="button"
            className="resize-handle"
            aria-label={`Resize ${field.label}`}
            title="Drag to resize"
            onPointerDown={(event) => startGeometryGesture(event, "resize")}
            onPointerMove={updateGeometry}
            onPointerUp={finishGeometry}
            onPointerCancel={finishGeometry}
          />
        </>
      )}
    </div>
  );
}

function PageCanvas({
  page,
  previewImage,
  createBoxMode,
  candidates,
  fields,
  selectedFieldId,
  onDirectCandidateClick,
  onCreateTextBox,
  onFieldClick,
  onClearFieldSelection,
  onFieldTextChange,
  onFieldGeometryChange,
  onOverflow,
}: PageCanvasProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [scale, setScale] = useState(1);
  const [imageVersion, setImageVersion] = useState(0);
  const [autoBackgrounds, setAutoBackgrounds] = useState<
    Record<string, string>
  >({});
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragCurrent, setDragCurrent] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const activePageImage = previewImage ?? page.image;
  const candidateGroups = useMemo(
    () => candidateParagraphGroups(candidates),
    [candidates],
  );

  const marquee = useMemo<BoundingBox | null>(() => {
    if (!dragStart || !dragCurrent) return null;
    return {
      left: Math.min(dragStart.x, dragCurrent.x),
      top: Math.min(dragStart.y, dragCurrent.y),
      width: Math.abs(dragCurrent.x - dragStart.x),
      height: Math.abs(dragCurrent.y - dragStart.y),
    };
  }, [dragCurrent, dragStart]);
  function pointerPosition(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * page.width,
      y: ((event.clientY - bounds.top) / bounds.height) * page.height,
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const drawingTextBox = createBoxMode;
    const target = event.target as HTMLElement;
    if (!drawingTextBox) {
      if (!target.closest(".managed-overlay, .candidate-box")) {
        onClearFieldSelection();
      }
      return;
    }
    if (!drawingTextBox) return;
    if (target.closest(".managed-hitbox, .resize-handle")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    setDragStart(point);
    setDragCurrent(point);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart || !createBoxMode) return;
    setDragCurrent(pointerPosition(event));
  }

  function finishMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart || !dragCurrent || !createBoxMode) return;
    const drawn = marquee;
    onCreateTextBox(
      drawn && drawn.width >= 20 && drawn.height >= 18
        ? drawn
        : {
            left: Math.min(dragStart.x, page.width - 220),
            top: Math.min(dragStart.y, page.height - 60),
            width: 220,
            height: 60,
          },
    );
    setDragStart(null);
    setDragCurrent(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / page.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [page.width]);

  useEffect(() => {
    const image = imageRef.current;
    if (!image?.complete || !fields.length) {
      setAutoBackgrounds({});
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = page.width;
    canvas.height = page.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, page.width, page.height);
    setAutoBackgrounds(
      Object.fromEntries(
        fields.map((field) => [
          field.id,
          sampledBackground(context, page, field.bbox),
        ]),
      ),
    );
  }, [fields, imageVersion, page]);

  return (
    <section className="page-shell" id={`page-${page.number}`}>
      <div className="page-number-label">Page {page.number}</div>
      <div
        className={`pdf-page edit-mode ${
          createBoxMode ? "create-box-mode" : ""
        }`}
        ref={pageRef}
        style={{ aspectRatio: `${page.width} / ${page.height}` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishMarquee}
        onPointerCancel={finishMarquee}
      >
        <img
          ref={imageRef}
          src={activePageImage}
          alt={`Chapter 37 page ${page.number}`}
          onLoad={() => setImageVersion((current) => current + 1)}
        />
        {!createBoxMode &&
          candidateGroups.map((group) => {
            const bbox = unionBoxes(group);
            const text = paragraphText(group);
            return (
              <button
                key={group.map((candidate) => candidate.id).join("-")}
                type="button"
                data-candidate-id={group[0].id}
                className="candidate-box direct-candidate"
                style={{
                  left: `${(bbox.left / page.width) * 100}%`,
                  top: `${(bbox.top / page.height) * 100}%`,
                  width: `${(bbox.width / page.width) * 100}%`,
                  height: `${(bbox.height / page.height) * 100}%`,
                }}
                onClick={() => onDirectCandidateClick(group)}
                aria-label={`Select text: ${text}`}
                title={text}
              />
            );
          })}
        {createBoxMode &&
          marquee &&
          (marquee.width > 3 || marquee.height > 3) && (
            <div
              className="selection-marquee"
              style={{
                left: `${(marquee.left / page.width) * 100}%`,
                top: `${(marquee.top / page.height) * 100}%`,
                width: `${(marquee.width / page.width) * 100}%`,
                height: `${(marquee.height / page.height) * 100}%`,
              }}
            />
          )}
        {fields.map((field) => (
          <ManagedOverlay
            key={field.id}
            field={field}
            page={page}
            scale={scale}
            selected={field.id === selectedFieldId}
            onClick={() => onFieldClick(field)}
            onOverflow={(overflowing) => onOverflow(field.id, overflowing)}
            resolvedBackground={
              field.backgroundMode === "auto"
                ? autoBackgrounds[field.id] ?? field.backgroundColor
                : field.backgroundColor
            }
            renderTextPreview={!previewImage}
            onTextChange={(text) => onFieldTextChange(field.id, text)}
            onGeometryChange={(bbox) =>
              onFieldGeometryChange(field.id, bbox)
            }
          />
        ))}
      </div>
    </section>
  );
}

function EmptyInspector() {
  return (
    <div className="empty-inspector">
      <div className="empty-icon">
        <FilePenLine />
      </div>
      <h3>Choose text on the PDF</h3>
      <p>
        Click any line to edit its whole paragraph when possible. The side
        panel is your formatting toolbar.
      </p>
    </div>
  );
}

function App() {
  const [manifest, setManifest] = useState<SourceManifest | null>(null);
  const [fields, setFields] = useState<ManagedField[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [createBoxMode, setCreateBoxMode] = useState(false);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("field");
  const [author, setAuthor] = useState("");
  const [revisionNote, setRevisionNote] = useState("");
  const [overflowIds, setOverflowIds] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [exporting, setExporting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [previewPages, setPreviewPages] = useState<Record<number, string>>({});
  const [previewStatus, setPreviewStatus] = useState<
    "idle" | "rendering" | "ready" | "error"
  >("idle");
  const [canUndo, setCanUndo] = useState(false);
  const previewPagesRef = useRef<Record<number, string>>({});
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const undoCurrentRef = useRef<UndoSnapshot | null>(null);
  const undoCurrentSignatureRef = useRef("");
  const undoPendingRef = useRef<UndoSnapshot | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  function replacePreviewPages(next: Record<number, string>) {
    const previous = previewPagesRef.current;
    Object.entries(previous).forEach(([pageNumber, url]) => {
      if (next[Number(pageNumber)] !== url) URL.revokeObjectURL(url);
    });
    previewPagesRef.current = next;
    setPreviewPages(next);
  }

  useEffect(() => {
    let active = true;
    async function hydrate() {
      const response = await fetch("/source/manifest.json");
      if (!response.ok) throw new Error("Could not load the source manifest.");
      const loadedManifest = (await response.json()) as SourceManifest;
      const persisted = await loadState(loadedManifest.documentId);
      if (!active) return;
      setManifest(loadedManifest);
      if (persisted) {
        const normalizedFields = persisted.fields.map(normalizeField);
        setFields(normalizedFields);
        setRevisions(
          persisted.revisions.map((revision) =>
            normalizeRevision(revision, normalizedFields),
          ),
        );
        setAuthor(persisted.author);
      }
      setHydrated(true);
    }
    hydrate().catch((error: unknown) => {
      setToast(error instanceof Error ? error.message : "Could not start app.");
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!manifest || !hydrated) return;
    setSaveStatus("saving");
    const timeout = window.setTimeout(() => {
      const state: PersistedState = {
        fields,
        revisions,
        author,
        updatedAt: new Date().toISOString(),
      };
      saveState(manifest.documentId, state)
        .then(() => setSaveStatus("saved"))
        .catch(() => setToast("Local autosave failed."));
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [author, fields, hydrated, manifest, revisions]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  function commitPendingUndo() {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    const pending = undoPendingRef.current;
    if (!pending) return;
    undoStackRef.current = [
      ...undoStackRef.current.slice(-(MAX_UNDO_STEPS - 1)),
      pending,
    ];
    undoPendingRef.current = null;
    setCanUndo(true);
  }

  useEffect(() => {
    if (!hydrated) return;
    const next = createUndoSnapshot(fields, revisions);
    if (!undoCurrentRef.current) {
      undoCurrentRef.current = next.snapshot;
      undoCurrentSignatureRef.current = next.signature;
      return;
    }
    if (next.signature === undoCurrentSignatureRef.current) return;

    if (!undoPendingRef.current) {
      undoPendingRef.current = undoCurrentRef.current;
    }
    undoCurrentRef.current = next.snapshot;
    undoCurrentSignatureRef.current = next.signature;
    setCanUndo(true);

    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
    }
    undoTimerRef.current = window.setTimeout(() => {
      commitPendingUndo();
    }, UNDO_GROUP_DELAY_MS);
  }, [fields, hydrated, revisions]);

  useEffect(
    () => () => {
      if (undoTimerRef.current !== null) {
        window.clearTimeout(undoTimerRef.current);
      }
    },
    [],
  );

  const managedCandidateIds = useMemo(
    () => new Set(fields.flatMap((field) => field.candidateIds)),
    [fields],
  );
  const selectedField =
    fields.find((field) => field.id === selectedFieldId) ?? null;
  const pendingChanges = revisionChanges(fields, revisions);

  const masterDocument = useMemo<MasterDocument | null>(() => {
    if (!manifest) return null;
    return {
      schemaVersion: 1,
      documentId: manifest.documentId,
      title: manifest.title,
      sourcePdfHash: manifest.sourcePdfHash,
      coordinateScale: manifest.coordinateScale,
      fields,
      revisions,
    };
  }, [fields, manifest, revisions]);

  useEffect(() => {
    return () => {
      Object.values(previewPagesRef.current).forEach((url) =>
        URL.revokeObjectURL(url),
      );
    };
  }, []);

  useEffect(() => {
    const changedPages = [
      ...new Set(
        fields.filter(fieldWasChanged).map((field) => field.page),
      ),
    ];
    if (!masterDocument || !changedPages.length) {
      replacePreviewPages({});
      setPreviewStatus("idle");
      return;
    }

    replacePreviewPages({});
    setPreviewStatus("rendering");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      Promise.all(
        changedPages.map(async (pageNumber) => {
          const response = await fetch(`/api/preview/page/${pageNumber}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ document: masterDocument }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(await responseError(response));
          return [pageNumber, URL.createObjectURL(await response.blob())] as const;
        }),
      )
        .then((entries) => {
          if (controller.signal.aborted) {
            entries.forEach(([, url]) => URL.revokeObjectURL(url));
            return;
          }
          replacePreviewPages(Object.fromEntries(entries));
          setPreviewStatus("ready");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreviewStatus("error");
          if (error instanceof Error && !overflowIds.size) {
            setToast(`Exact preview unavailable: ${error.message}`);
          }
        });
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [fields, masterDocument]);

  function showField(field: ManagedField) {
    setCreateBoxMode(false);
    setSelectedFieldId(field.id);
    setInspectorTab("field");
  }

  function handleDirectCandidateClick(groupedCandidates: Candidate[]) {
    const firstCandidate = groupedCandidates[0];
    if (!firstCandidate) return;
    const groupedText = paragraphText(groupedCandidates);
    const label =
      groupedText.slice(0, 32) || `Text on page ${firstCandidate.page}`;
    const field = createManagedField(
      groupedCandidates,
      label,
      "#ffffff",
    );
    field.originalText = groupedText;
    field.currentText = groupedText;
    setFields((current) => [...current, field]);
    setSelectedFieldId(field.id);
    setInspectorTab("field");
    setToast(
      groupedCandidates.length > 1
        ? `Grouped ${groupedCandidates.length} lines into one editable paragraph.`
        : "Text is ready to edit directly on the page.",
    );
  }

  function createTextBox(page: number, bbox: BoundingBox) {
    const field: ManagedField = {
      id: crypto.randomUUID(),
      label: `Text box ${fields.length + 1}`,
      page,
      candidateIds: [],
      bbox: { ...bbox },
      originalBbox: { ...bbox },
      sourceBbox: null,
      originalText: "",
      currentText: "",
      fontFamily: "Times New Roman",
      fontSize: 14,
      originalFontSize: 14,
      bold: false,
      color: "#000000",
      originalColor: "#000000",
      backgroundMode: "auto",
      backgroundColor: "#ffffff",
      originalBackgroundColor: "#ffffff",
      align: "left",
      originalAlign: "left",
      listStyle: "none",
      originalListStyle: "none",
      firstLineTab: false,
      originalFirstLineTab: false,
      lineHeight: 1.13,
      originalLineHeight: 1.13,
      leftIndent: 0,
      originalLeftIndent: 0,
      firstLineIndent: 0,
      originalFirstLineIndent: 0,
      tabInterval: 54,
      originalTabInterval: 54,
      tabStops: [],
      originalTabStops: [],
      fitMode: "fixed",
    };
    setFields((current) => [...current, field]);
    setSelectedFieldId(field.id);
    setCreateBoxMode(false);
    setInspectorTab("field");
    setToast("New text box added. Type directly on the page.");
  }

  function updateField(
    fieldId: string,
    patch: Partial<ManagedField>,
  ): void {
    setFields((current) =>
      current.map((field) =>
        field.id === fieldId ? { ...field, ...patch } : field,
      ),
    );
  }

  function deleteField(fieldId: string) {
    const field = fields.find((item) => item.id === fieldId);
    if (field?.sourceBbox) {
      updateField(fieldId, { currentText: "" });
      setSelectedFieldId(null);
      setToast(`Removed ${field.label} from the exported layout.`);
      return;
    }
    setFields((current) => current.filter((item) => item.id !== fieldId));
    setSelectedFieldId(null);
    setOverflowIds((current) => {
      const next = new Set(current);
      next.delete(fieldId);
      return next;
    });
    setToast(`Deleted ${field?.label ?? "text box"}.`);
  }

  function saveRevision() {
    if (!author.trim() || !revisionNote.trim()) {
      setToast("Enter an author and revision note.");
      return;
    }
    const changes = revisionChanges(fields, revisions);
    if (!changes.length) {
      setToast("There are no unsaved changes.");
      return;
    }
    const revision: Revision = {
      id: crypto.randomUUID(),
      number: revisions.length + 1,
      author: author.trim(),
      note: revisionNote.trim(),
      createdAt: new Date().toISOString(),
      changes,
      snapshot: snapshotFields(fields),
    };
    commitPendingUndo();
    setRevisions((current) => [...current, revision]);
    setRevisionNote("");
    setToast(`Saved revision ${revision.number}.`);
  }

  function restoreRevision(revision: Revision) {
    setFields((current) =>
      current.map((field) => ({
        ...field,
        currentText: revision.snapshot[field.id]?.text ?? field.originalText,
        bbox: revision.snapshot[field.id]?.bbox
          ? { ...revision.snapshot[field.id].bbox }
          : { ...field.originalBbox },
        fontSize:
          revision.snapshot[field.id]?.fontSize ?? field.originalFontSize,
        color: revision.snapshot[field.id]?.color ?? field.originalColor,
        backgroundMode:
          revision.snapshot[field.id]?.backgroundMode ?? "auto",
        backgroundColor:
          revision.snapshot[field.id]?.backgroundColor ??
          field.originalBackgroundColor,
        align: revision.snapshot[field.id]?.align ?? field.originalAlign,
        listStyle:
          revision.snapshot[field.id]?.listStyle ?? field.originalListStyle,
        firstLineTab:
          revision.snapshot[field.id]?.firstLineTab ??
          field.originalFirstLineTab,
        lineHeight:
          revision.snapshot[field.id]?.lineHeight ?? field.originalLineHeight,
        leftIndent:
          revision.snapshot[field.id]?.leftIndent ?? field.originalLeftIndent,
        firstLineIndent:
          revision.snapshot[field.id]?.firstLineIndent ??
          field.originalFirstLineIndent,
        tabInterval:
          revision.snapshot[field.id]?.tabInterval ?? field.originalTabInterval,
        tabStops:
          revision.snapshot[field.id]?.tabStops ?? field.originalTabStops,
      })),
    );
    setInspectorTab("field");
    setToast(
      `Restored revision ${revision.number} as a draft. Save it to record a new revision.`,
    );
  }

  async function exportFile(
    endpoint: "pdf" | "changelog",
    suffix: string,
  ) {
    if (!masterDocument) return;
    if (endpoint === "pdf" && overflowIds.size) {
      setToast("Resolve overflowing fields before exporting the revised PDF.");
      return;
    }
    setExporting(endpoint);
    try {
      const response = await fetch(`/api/export/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: masterDocument }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      downloadBlob(
        await response.blob(),
        `${slugify(masterDocument.title)}-${suffix}.pdf`,
      );
      setToast(`${endpoint === "pdf" ? "Revised PDF" : "Change log"} exported.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  }

  function exportJson() {
    if (!masterDocument) return;
    downloadBlob(
      new Blob([JSON.stringify(masterDocument, null, 2)], {
        type: "application/json",
      }),
      `${slugify(masterDocument.title)}-master.json`,
    );
    setToast("Master JSON backup exported.");
  }

  async function importJson(file: File) {
    if (!manifest) return;
    try {
      const document = JSON.parse(await file.text()) as MasterDocument;
      if (
        document.schemaVersion !== 1 ||
        document.documentId !== manifest.documentId ||
        document.sourcePdfHash !== manifest.sourcePdfHash ||
        !Array.isArray(document.fields) ||
        !Array.isArray(document.revisions)
      ) {
        throw new Error("This backup does not match the Chapter 37 source.");
      }
      commitPendingUndo();
      const normalizedFields = document.fields.map(normalizeField);
      setFields(normalizedFields);
      setRevisions(
        document.revisions.map((revision) =>
          normalizeRevision(revision, normalizedFields),
        ),
      );
      setSelectedFieldId(null);
      setToast("Master JSON backup restored.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Import failed.");
    }
  }

  async function resetEverything() {
    if (!manifest) return;
    const confirmed = window.confirm(
      "Reset everything?\n\nThis will remove all managed text boxes, edits, and revision history from this browser. The original PDF will not be changed.",
    );
    if (!confirmed) return;
    commitPendingUndo();

    const resetState: PersistedState = {
      fields: [],
      revisions: [],
      author: "",
      updatedAt: new Date().toISOString(),
    };

    setFields([]);
    setRevisions([]);
    setAuthor("");
    setRevisionNote("");
    setSelectedFieldId(null);
    setOverflowIds(new Set());
    setCreateBoxMode(false);
    setInspectorTab("field");
    replacePreviewPages({});
    setPreviewStatus("idle");
    setSaveStatus("saving");

    try {
      await saveState(manifest.documentId, resetState);
      setSaveStatus("saved");
      setToast("Everything was reset to the original PDF.");
    } catch {
      setToast("The editor was reset, but the local reset could not be saved.");
    }
  }

  function undoLastChange() {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }

    const target =
      undoPendingRef.current ?? undoStackRef.current.at(-1) ?? null;
    if (!target) return;

    if (undoPendingRef.current) {
      undoPendingRef.current = null;
    } else {
      undoStackRef.current = undoStackRef.current.slice(0, -1);
    }

    const restored = createUndoSnapshot(target.fields, target.revisions);
    undoCurrentRef.current = restored.snapshot;
    undoCurrentSignatureRef.current = restored.signature;
    setFields(restored.snapshot.fields);
    setRevisions(restored.snapshot.revisions);
    setSelectedFieldId(null);
    setOverflowIds(new Set());
    setCreateBoxMode(false);
    setInspectorTab("field");
    replacePreviewPages({});
    setPreviewStatus("idle");
    setCanUndo(undoStackRef.current.length > 0);
    setToast("Undid the last change.");
  }

  if (!manifest) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" />
        <h1>Preparing Chapter Master</h1>
        <p>Loading the page map and local revision history…</p>
        {toast && <div className="loading-error">{toast}</div>}
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Layers3 />
          </div>
          <div>
            <div className="eyebrow">Tracked PDF workspace</div>
            <h1>Chapter Master</h1>
          </div>
        </div>

        <div className="editor-mode-label" aria-label="Layout editor">
          <Move />
          <div>
            <strong>Layout editor</strong>
            <span>Direct PDF editing</span>
          </div>
        </div>

        <div className="topbar-actions">
          <div className={`save-status ${saveStatus}`}>
            {saveStatus === "saving" ? (
              <LoaderCircle className="spin" />
            ) : (
              <Check />
            )}
            {saveStatus === "saving" ? "Saving" : "Saved locally"}
          </div>
          <button
            type="button"
            className="button secondary undo-button"
            onClick={undoLastChange}
            disabled={!canUndo}
            title="Undo last change"
          >
            <Undo2 /> Undo
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setInspectorTab("history");
              setSelectedFieldId(null);
            }}
          >
            <History /> History
            {pendingChanges.length > 0 && (
              <span className="badge">{pendingChanges.length}</span>
            )}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => exportFile("pdf", "revised")}
            disabled={exporting !== null || !fields.length}
          >
            {exporting === "pdf" ? (
              <LoaderCircle className="spin" />
            ) : (
              <FileDown />
            )}
            Export PDF
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-sidebar">
          <div className="document-summary">
            <div className="document-icon">
              <Archive />
            </div>
            <div>
              <div className="eyebrow">Active master</div>
              <h2>{manifest.title}</h2>
              <p>
                {manifest.pages.length} pages · {fields.length} managed fields
              </p>
            </div>
          </div>

          <div className="sidebar-section-title">
            <span>Pages</span>
            <span>{manifest.pages.length}</span>
          </div>
          <nav className="page-nav">
            {manifest.pages.map((page) => {
              const pageFields = fields.filter(
                (field) => field.page === page.number,
              ).length;
              return (
                <button
                  key={page.number}
                  type="button"
                  onClick={() =>
                    document
                      .getElementById(`page-${page.number}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  <img src={page.image} alt="" />
                  <span>Page {page.number}</span>
                  {pageFields > 0 && <b>{pageFields}</b>}
                  <ChevronRight />
                </button>
              );
            })}
          </nav>

          <div className="sidebar-tools">
            <div className="sidebar-section-title">
              <span>Master data</span>
            </div>
            <button type="button" onClick={exportJson}>
              <FileJson /> Download JSON backup
            </button>
            <button type="button" onClick={() => importRef.current?.click()}>
              <Upload /> Restore JSON backup
            </button>
            <button
              type="button"
              onClick={() => exportFile("changelog", "change-log")}
              disabled={exporting !== null}
            >
              <FileClock /> Download change log
            </button>
            <button
              type="button"
              className="reset-master"
              onClick={() => void resetEverything()}
              disabled={
                !fields.length &&
                !revisions.length &&
                !author &&
                !revisionNote
              }
            >
              <Trash2 /> Reset everything
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importJson(file);
                event.target.value = "";
              }}
            />
          </div>
        </aside>

        <main className="document-stage">
          <div className="stage-banner">
            <div>
              <FilePenLine />
              <div>
                <strong>Direct layout mode</strong>
                <span>
                  {createBoxMode
                    ? "Drag anywhere on a page to draw a new text box."
                    : "Click a line to edit its paragraph. Use the Move grip or resize handle to adjust its box."}
                </span>
              </div>
            </div>
            <button
              type="button"
              className={`button secondary add-text-box ${
                createBoxMode ? "active" : ""
              }`}
              onClick={() => {
                setCreateBoxMode((current) => !current);
                setSelectedFieldId(null);
              }}
            >
              <Type />
              {createBoxMode ? "Cancel text box" : "Add text box"}
            </button>
            {overflowIds.size > 0 && (
              <div className="overflow-banner">
                <AlertTriangle />
                {overflowIds.size} field{overflowIds.size === 1 ? "" : "s"}{" "}
                overflowing
              </div>
            )}
            {previewStatus === "rendering" && (
              <div className="preview-render-status">
                <LoaderCircle className="spin" />
                Matching export preview
              </div>
            )}
          </div>

          <div className="pages">
            {manifest.pages.map((page) => (
              <PageCanvas
                key={page.number}
                page={page}
                previewImage={previewPages[page.number]}
                createBoxMode={createBoxMode}
                candidates={manifest.candidates.filter(
                  (candidate) =>
                    candidate.page === page.number &&
                    !managedCandidateIds.has(candidate.id),
                )}
                fields={fields.filter((field) => field.page === page.number)}
                selectedFieldId={selectedFieldId}
                onDirectCandidateClick={handleDirectCandidateClick}
                onCreateTextBox={(bbox) => createTextBox(page.number, bbox)}
                onFieldClick={showField}
                onClearFieldSelection={() => setSelectedFieldId(null)}
                onFieldTextChange={(fieldId, text) =>
                  updateField(fieldId, { currentText: text })
                }
                onFieldGeometryChange={(fieldId, bbox) =>
                  updateField(fieldId, { bbox })
                }
                onOverflow={(fieldId, overflowing) =>
                  setOverflowIds((current) => {
                    if (overflowing === current.has(fieldId)) return current;
                    const next = new Set(current);
                    if (overflowing) next.add(fieldId);
                    else next.delete(fieldId);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </main>

        <aside className="inspector">
          <div className="inspector-tabs">
            <button
              type="button"
              className={inspectorTab === "field" ? "active" : ""}
              onClick={() => setInspectorTab("field")}
            >
              <PanelRight /> Tools
            </button>
            <button
              type="button"
              className={inspectorTab === "history" ? "active" : ""}
              onClick={() => setInspectorTab("history")}
            >
              <Clock3 /> History
            </button>
          </div>

          {inspectorTab === "history" ? (
            <div className="inspector-body history-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">Version control</div>
                  <h2>Revision history</h2>
                </div>
                <span>{revisions.length}</span>
              </div>

              <div className="revision-form">
                <label>
                  Author
                  <input
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                    placeholder="Your name"
                  />
                </label>
                <label>
                  Revision note
                  <textarea
                    value={revisionNote}
                    onChange={(event) => setRevisionNote(event.target.value)}
                    placeholder="What changed and why?"
                    rows={3}
                  />
                </label>
                <button
                  type="button"
                  className="button primary wide"
                  onClick={saveRevision}
                  disabled={!pendingChanges.length}
                >
                  <Save /> Save revision
                  {pendingChanges.length > 0 && (
                    <span className="badge light">{pendingChanges.length}</span>
                  )}
                </button>
                {!pendingChanges.length && (
                  <p className="form-hint">All text changes are already saved.</p>
                )}
              </div>

              <div className="revision-list">
                {[...revisions].reverse().map((revision) => (
                  <article key={revision.id} className="revision-card">
                    <div className="revision-card-head">
                      <span>R{revision.number}</span>
                      <time>
                        {new Intl.DateTimeFormat(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }).format(new Date(revision.createdAt))}
                      </time>
                    </div>
                    <h3>{revision.note}</h3>
                    <p>
                      {revision.author} · {revision.changes.length} change
                      {revision.changes.length === 1 ? "" : "s"}
                    </p>
                    <div className="revision-changes">
                      {revision.changes.map((change) => (
                        <details key={`${revision.id}-${change.fieldId}`}>
                          <summary>{change.label}</summary>
                          <div className="diff before">{change.before}</div>
                          <div className="diff after">{change.after}</div>
                          {change.beforeStyle !== change.afterStyle && (
                            <div className="format-diff">
                              {change.beforeStyle} → {change.afterStyle}
                            </div>
                          )}
                        </details>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => restoreRevision(revision)}
                    >
                      <RotateCcw /> Restore as draft
                    </button>
                  </article>
                ))}
                {!revisions.length && (
                  <div className="empty-history">
                    <FileClock />
                    <h3>No revisions yet</h3>
                    <p>
                      Edit a managed field, then save the first named revision.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="inspector-body">
              {selectedField && (
                <>
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">
                        Text tools · Page {selectedField.page}
                      </div>
                      <h2>{selectedField.label}</h2>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setSelectedFieldId(null)}
                      aria-label="Close field"
                    >
                      <X />
                    </button>
                  </div>

                  <div className="field-form tool-panel">
                    <div className="direct-edit-callout">
                      <Type />
                      <div>
                        <strong>Edit directly on the PDF</strong>
                        <span>
                          Type inside the selected box. This panel controls its
                          appearance and layout.
                        </span>
                      </div>
                    </div>

                    <label>
                      Layer name
                      <input
                        value={selectedField.label}
                        onChange={(event) =>
                          updateField(selectedField.id, {
                            label: event.target.value,
                          })
                        }
                      />
                    </label>

                    <div className="list-style-field">
                      <span>List style</span>
                      <div
                        className="list-style-picker"
                        role="group"
                        aria-label="List style"
                      >
                        <button
                          type="button"
                          className={
                            selectedField.listStyle === "none" ? "active" : ""
                          }
                          onClick={() =>
                            updateField(selectedField.id, {
                              listStyle: "none",
                            })
                          }
                        >
                          Plain text
                        </button>
                        <button
                          type="button"
                          className={
                            selectedField.listStyle === "bullet"
                              ? "active"
                              : ""
                          }
                          onClick={() =>
                            updateField(selectedField.id, {
                              listStyle: "bullet",
                            })
                          }
                        >
                          <List /> Bullets
                        </button>
                        <button
                          type="button"
                          className={
                            selectedField.listStyle === "number"
                              ? "active"
                              : ""
                          }
                          onClick={() =>
                            updateField(selectedField.id, {
                              listStyle: "number",
                            })
                          }
                        >
                          <ListOrdered /> Numbered
                        </button>
                      </div>
                      {selectedField.listStyle !== "none" && (
                        <small>
                          Type one item per line on the PDF. Markers appear
                          when you deselect the box and in the export.
                        </small>
                      )}
                    </div>

                    {selectedField.listStyle === "none" && (
                      <button
                        type="button"
                        className={`first-line-tab-toggle ${
                          selectedField.firstLineTab ? "active" : ""
                        }`}
                        aria-pressed={selectedField.firstLineTab}
                        onClick={() =>
                          updateField(selectedField.id, {
                            firstLineTab: !selectedField.firstLineTab,
                          })
                        }
                      >
                        <span>
                          <strong>Indent first line</strong>
                          <small>Move only the first line in by one tab.</small>
                        </span>
                        <i aria-hidden="true" />
                      </button>
                    )}

                    <div className="form-row">
                      <label>
                        Font size
                        <input
                          type="number"
                          min="6"
                          max="72"
                          step="0.5"
                          value={selectedField.fontSize}
                          onChange={(event) =>
                            updateField(selectedField.id, {
                              fontSize: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Alignment
                        <select
                          value={selectedField.align}
                          onChange={(event) =>
                            updateField(selectedField.id, {
                              align: event.target
                                .value as ManagedField["align"],
                            })
                          }
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                          <option value="right">Right</option>
                        </select>
                      </label>
                    </div>

                    <fieldset className="geometry-controls">
                      <legend>Position and size</legend>
                      <div className="geometry-grid">
                        {(
                          [
                            ["X", "left"],
                            ["Y", "top"],
                            ["W", "width"],
                            ["H", "height"],
                          ] as const
                        ).map(([label, property]) => (
                          <label key={property}>
                            {label}
                            <input
                              type="number"
                              min={property === "width" || property === "height" ? 1 : 0}
                              step="1"
                              value={Math.round(selectedField.bbox[property])}
                              onChange={(event) =>
                                updateField(selectedField.id, {
                                  bbox: {
                                    ...selectedField.bbox,
                                    [property]: Math.max(
                                      property === "width" ||
                                        property === "height"
                                        ? 1
                                        : 0,
                                      Number(event.target.value),
                                    ),
                                  },
                                })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      <small>
                        Drag the Move grip above the text. Use the lower-right
                        handle to resize. Arrow keys on the grip nudge the box.
                      </small>
                    </fieldset>

                    <label>
                      Fit behavior
                      <select
                        value={selectedField.fitMode}
                        onChange={(event) =>
                          updateField(selectedField.id, {
                            fitMode: event.target
                              .value as ManagedField["fitMode"],
                          })
                        }
                      >
                        <option value="fixed">Strict original size</option>
                        <option value="shrink">
                          Auto-fit single-line display text
                        </option>
                      </select>
                    </label>

                    <label>
                      Background handling
                      <select
                        value={selectedField.backgroundMode}
                        onChange={(event) =>
                          updateField(selectedField.id, {
                            backgroundMode: event.target
                              .value as ManagedField["backgroundMode"],
                          })
                        }
                      >
                        <option value="auto">Match source automatically</option>
                        <option value="manual">Choose a solid color</option>
                      </select>
                    </label>

                    <div className="form-row">
                      <label>
                        Text color
                        <div className="color-control compact">
                          <input
                            type="color"
                            value={selectedField.color}
                            onChange={(event) =>
                              updateField(selectedField.id, {
                                color: event.target.value,
                              })
                            }
                          />
                          <span>{selectedField.color}</span>
                        </div>
                      </label>
                      <label>
                        Background
                        <div className="color-control compact">
                          <input
                            type="color"
                            value={selectedField.backgroundColor}
                            disabled={selectedField.backgroundMode === "auto"}
                            onChange={(event) =>
                              updateField(selectedField.id, {
                                backgroundColor: event.target.value,
                              })
                            }
                          />
                          <span>
                            {selectedField.backgroundMode === "auto"
                              ? "Sampled from source"
                              : selectedField.backgroundColor}
                          </span>
                        </div>
                      </label>
                    </div>

                    {overflowIds.has(selectedField.id) && (
                      <div className="field-warning">
                        <AlertTriangle />
                        <div>
                          <strong>Text does not fit</strong>
                          <span>
                            Shorten it or reduce the font size before exporting.
                          </span>
                        </div>
                      </div>
                    )}

                    {(selectedField.currentText !==
                        selectedField.originalText ||
                        selectedField.fontSize !==
                          selectedField.originalFontSize ||
                        selectedField.color !== selectedField.originalColor ||
                        selectedField.backgroundMode !== "auto" ||
                        selectedField.backgroundColor !==
                          selectedField.originalBackgroundColor ||
                        selectedField.align !==
                          selectedField.originalAlign ||
                        selectedField.listStyle !==
                          selectedField.originalListStyle ||
                        selectedField.firstLineTab !==
                          selectedField.originalFirstLineTab ||
                        !boxesEqual(
                          selectedField.bbox,
                          selectedField.originalBbox,
                        ) ||
                        selectedField.lineHeight !==
                          selectedField.originalLineHeight ||
                        selectedField.leftIndent !==
                          selectedField.originalLeftIndent ||
                        selectedField.firstLineIndent !==
                          selectedField.originalFirstLineIndent ||
                        selectedField.tabInterval !==
                          selectedField.originalTabInterval ||
                        JSON.stringify(selectedField.tabStops) !==
                          JSON.stringify(selectedField.originalTabStops)) && (
                        <button
                          type="button"
                          className="button secondary wide"
                          onClick={() =>
                            updateField(selectedField.id, {
                              currentText: selectedField.originalText,
                              bbox: { ...selectedField.originalBbox },
                              fontSize: selectedField.originalFontSize,
                              color: selectedField.originalColor,
                              backgroundMode: "auto",
                              backgroundColor:
                                selectedField.originalBackgroundColor,
                              align: selectedField.originalAlign,
                              listStyle: selectedField.originalListStyle,
                              firstLineTab:
                                selectedField.originalFirstLineTab,
                              lineHeight: selectedField.originalLineHeight,
                              leftIndent: selectedField.originalLeftIndent,
                              firstLineIndent:
                                selectedField.originalFirstLineIndent,
                              tabInterval: selectedField.originalTabInterval,
                              tabStops: selectedField.originalTabStops,
                            })
                          }
                        >
                          <RotateCcw /> Reset to source text
                        </button>
                      )}

                    <button
                      type="button"
                      className="button danger wide"
                      onClick={() => deleteField(selectedField.id)}
                    >
                      <Trash2 /> Delete text box
                    </button>
                  </div>
                </>
              )}

              {!selectedField && <EmptyInspector />}
            </div>
          )}
        </aside>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;

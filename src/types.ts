export type Mode = "setup" | "edit";

export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
}

export interface Candidate {
  id: string;
  page: number;
  text: string;
  bbox: BoundingBox;
  style: TextStyle;
  previewPatch?: string;
  previewPatchBox?: BoundingBox;
}

export interface PageDefinition {
  number: number;
  width: number;
  height: number;
  image: string;
}

export interface SourceManifest {
  schemaVersion: number;
  documentId: string;
  title: string;
  sourcePdf: string;
  sourcePdfHash: string;
  coordinateScale: number;
  pages: PageDefinition[];
  candidates: Candidate[];
}

export interface ManagedField {
  id: string;
  label: string;
  page: number;
  candidateIds: string[];
  bbox: BoundingBox;
  originalText: string;
  currentText: string;
  fontFamily: string;
  fontSize: number;
  originalFontSize: number;
  bold: boolean;
  color: string;
  originalColor: string;
  backgroundMode: "auto" | "manual";
  backgroundColor: string;
  originalBackgroundColor: string;
  align: "left" | "center" | "right";
  originalAlign: "left" | "center" | "right";
  listStyle: "none" | "bullet" | "number";
  originalListStyle: "none" | "bullet" | "number";
  lineHeight: number;
  originalLineHeight: number;
  leftIndent: number;
  originalLeftIndent: number;
  firstLineIndent: number;
  originalFirstLineIndent: number;
  tabInterval: number;
  originalTabInterval: number;
  tabStops: number[];
  originalTabStops: number[];
  fitMode: "fixed" | "shrink";
  previewPatch?: string;
  previewPatchBox?: BoundingBox;
}

export interface FieldSnapshot {
  text: string;
  fontSize: number;
  color: string;
  backgroundMode: "auto" | "manual";
  backgroundColor: string;
  align: "left" | "center" | "right";
  listStyle: "none" | "bullet" | "number";
  lineHeight: number;
  leftIndent: number;
  firstLineIndent: number;
  tabInterval: number;
  tabStops: number[];
}

export interface FieldChange {
  fieldId: string;
  label: string;
  before: string;
  after: string;
  beforeStyle: string;
  afterStyle: string;
}

export interface Revision {
  id: string;
  number: number;
  author: string;
  note: string;
  createdAt: string;
  changes: FieldChange[];
  snapshot: Record<string, FieldSnapshot>;
}

export interface MasterDocument {
  schemaVersion: number;
  documentId: string;
  title: string;
  sourcePdfHash: string;
  coordinateScale: number;
  fields: ManagedField[];
  revisions: Revision[];
}

export interface PersistedState {
  fields: ManagedField[];
  revisions: Revision[];
  author: string;
  updatedAt: string;
}

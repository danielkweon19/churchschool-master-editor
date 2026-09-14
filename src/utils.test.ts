import { describe, expect, it } from "vitest";

import type { Candidate, ManagedField } from "./types";
import {
  candidateParagraphGroups,
  createManagedField,
  insertAtSelection,
  paragraphCandidates,
  paragraphText,
  revisionChanges,
  snapshotFields,
  unionBoxes,
} from "./utils";

const candidates: Candidate[] = [
  {
    id: "a",
    page: 1,
    text: "First line",
    bbox: { left: 20, top: 10, width: 80, height: 18 },
    style: {
      fontFamily: "Times New Roman",
      fontSize: 14,
      color: "#000000",
      bold: false,
    },
  },
  {
    id: "b",
    page: 1,
    text: "Second line",
    bbox: { left: 10, top: 28, width: 110, height: 18 },
    style: {
      fontFamily: "Times New Roman",
      fontSize: 14,
      color: "#000000",
      bold: false,
    },
  },
];

describe("document helpers", () => {
  it("unions selected PDF text boxes", () => {
    expect(unionBoxes(candidates)).toEqual({
      left: 10,
      top: 10,
      width: 110,
      height: 36,
    });
  });

  it("creates a managed field in visual reading order", () => {
    const field = createManagedField(
      [...candidates].reverse(),
      "Lesson",
      "#ffffff",
    );
    expect(field.originalText).toBe("First line\nSecond line");
    expect(field.candidateIds).toEqual(["a", "b"]);
    expect(field.lineHeight).toBeCloseTo(18 / 14);
    expect(field.leftIndent).toBe(0);
    expect(field.firstLineIndent).toBe(0);
  });

  it("groups adjacent paragraph lines but stops at paragraph gaps", () => {
    const paragraphLines: Candidate[] = [
      {
        ...candidates[0],
        id: "p1",
        text: "The first paragraph begins here",
        bbox: { left: 70, top: 100, width: 300, height: 18 },
      },
      {
        ...candidates[1],
        id: "p2",
        text: "and continues on its second line.",
        bbox: { left: 70, top: 116, width: 280, height: 18 },
      },
      {
        ...candidates[1],
        id: "p3",
        text: "A new paragraph starts after a gap.",
        bbox: { left: 70, top: 149, width: 290, height: 18 },
      },
    ];
    expect(
      paragraphCandidates(paragraphLines[1], paragraphLines).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["p1", "p2"]);
    expect(paragraphText(paragraphLines.slice(0, 2))).toBe(
      "The first paragraph begins here and continues on its second line.",
    );
  });

  it("keeps separate numbered items from merging", () => {
    const numberedLines: Candidate[] = [
      {
        ...candidates[0],
        id: "one",
        text: "1. First question starts here",
        bbox: { left: 70, top: 100, width: 300, height: 18 },
      },
      {
        ...candidates[1],
        id: "one-more",
        text: "and continues on another line.",
        bbox: { left: 88, top: 116, width: 280, height: 18 },
      },
      {
        ...candidates[1],
        id: "two",
        text: "2. Second question starts here",
        bbox: { left: 70, top: 132, width: 290, height: 18 },
      },
    ];
    expect(
      paragraphCandidates(numberedLines[1], numberedLines).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["one", "one-more"]);
  });

  it("continues a paragraph past interleaved text in another column", () => {
    const columnLines: Candidate[] = [
      {
        ...candidates[0],
        id: "left-one",
        text: "Left column first line",
        bbox: { left: 70, top: 100, width: 280, height: 18 },
      },
      {
        ...candidates[1],
        id: "right-column",
        text: "Unrelated right column text",
        bbox: { left: 440, top: 108, width: 150, height: 18 },
      },
      {
        ...candidates[1],
        id: "left-two",
        text: "Left column second line",
        bbox: { left: 70, top: 116, width: 270, height: 18 },
      },
    ];
    expect(
      paragraphCandidates(columnLines[0], columnLines).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["left-one", "left-two"]);
  });

  it("builds one visible selection region per paragraph", () => {
    const paragraphLines: Candidate[] = [
      {
        ...candidates[0],
        id: "first-a",
        bbox: { left: 70, top: 100, width: 280, height: 18 },
      },
      {
        ...candidates[1],
        id: "first-b",
        bbox: { left: 70, top: 116, width: 270, height: 18 },
      },
      {
        ...candidates[1],
        id: "second",
        bbox: { left: 70, top: 150, width: 250, height: 18 },
      },
    ];
    expect(
      candidateParagraphGroups(paragraphLines).map((group) =>
        group.map((candidate) => candidate.id),
      ),
    ).toEqual([["first-a", "first-b"], ["second"]]);
  });

  it("compares drafts with the last saved snapshot", () => {
    const field = createManagedField(candidates, "Lesson", "#ffffff");
    const fields: ManagedField[] = [
      {
        ...field,
        currentText: "Revised",
        bbox: { ...field.bbox, left: 15 },
      },
    ];
    expect(revisionChanges(fields, [])).toEqual([
      {
        fieldId: field.id,
        label: "Lesson",
        before: "First line\nSecond line",
        after: "Revised",
        beforeStyle:
          "x 10, y 10, 110×36, 14 source units, line 1.29, indents 0/0, left, text #000000, automatic source background",
        afterStyle:
          "x 15, y 10, 110×36, 14 source units, line 1.29, indents 0/0, left, text #000000, automatic source background",
      },
    ]);
    expect(snapshotFields(fields)[field.id].text).toBe("Revised");
    expect(snapshotFields(fields)[field.id].bbox.left).toBe(15);
  });

  it("inserts a literal tab at the current text selection", () => {
    expect(insertAtSelection("NameValue", 4, 4, "\t")).toEqual({
      value: "Name\tValue",
      caret: 5,
    });
  });
});

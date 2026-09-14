import { describe, expect, it } from "vitest";

import type { Candidate, ManagedField } from "./types";
import {
  candidatesInsideMarquee,
  createManagedField,
  insertAtSelection,
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

  it("selects text lines substantially crossed by a drag marquee", () => {
    expect(
      candidatesInsideMarquee(candidates, {
        left: 0,
        top: 20,
        width: 130,
        height: 30,
      }),
    ).toEqual(["a", "b"]);
    expect(
      candidatesInsideMarquee(candidates, {
        left: 0,
        top: 0,
        width: 10,
        height: 10,
      }),
    ).toEqual([]);
  });

  it("compares drafts with the last saved snapshot", () => {
    const field = createManagedField(candidates, "Lesson", "#ffffff");
    const fields: ManagedField[] = [{ ...field, currentText: "Revised" }];
    expect(revisionChanges(fields, [])).toEqual([
      {
        fieldId: field.id,
        label: "Lesson",
        before: "First line\nSecond line",
        after: "Revised",
        beforeStyle:
          "14 source units, line 1.29, indents 0/0, left, text #000000, automatic source background",
        afterStyle:
          "14 source units, line 1.29, indents 0/0, left, text #000000, automatic source background",
      },
    ]);
    expect(snapshotFields(fields)[field.id].text).toBe("Revised");
  });

  it("inserts a literal tab at the current text selection", () => {
    expect(insertAtSelection("NameValue", 4, 4, "\t")).toEqual({
      value: "Name\tValue",
      caret: 5,
    });
  });
});

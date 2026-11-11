/**
 * Label sheet templates: page size and the grid of stickers on it, in
 * millimetres. Each matches a common, widely sold sheet of address labels.
 */
export interface LabelTemplate {
  id: string;
  name: string;
  page: { width: number; height: number };
  columns: number;
  rows: number;
  label: { width: number; height: number };
  /** Top-left corner of the first label. */
  margin: { top: number; left: number };
  /** Distance between the start of one label and the start of the next. */
  pitch: { x: number; y: number };
}

export const LABEL_TEMPLATES: LabelTemplate[] = [
  {
    id: "a4-21",
    name: "A4, 21 labels (63.5 × 38.1 mm, like Avery L7160)",
    page: { width: 210, height: 297 },
    columns: 3,
    rows: 7,
    label: { width: 63.5, height: 38.1 },
    margin: { top: 15.15, left: 7.2 },
    pitch: { x: 66.04, y: 38.1 },
  },
  {
    id: "a4-24",
    name: "A4, 24 labels (63.5 × 33.9 mm, like Avery L7159)",
    page: { width: 210, height: 297 },
    columns: 3,
    rows: 8,
    label: { width: 63.5, height: 33.9 },
    margin: { top: 12.9, left: 6.5 },
    pitch: { x: 66.0, y: 33.9 },
  },
  {
    id: "letter-30",
    name: "Letter, 30 labels (1 × 2⅝ in, like Avery 5160)",
    page: { width: 215.9, height: 279.4 },
    columns: 3,
    rows: 10,
    label: { width: 66.675, height: 25.4 },
    margin: { top: 12.7, left: 4.7625 },
    pitch: { x: 69.85, y: 25.4 },
  },
];

export function labelsPerSheet(template: LabelTemplate): number {
  return template.columns * template.rows;
}

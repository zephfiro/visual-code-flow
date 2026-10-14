export interface TextOffsetChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

/** Translate a cursor anchor across edits expressed in pre-edit coordinates. */
export function translateAnchorOffset(
  original: number,
  changes: readonly TextOffsetChange[]
): number {
  let anchor = original;
  for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    const end = change.rangeOffset + change.rangeLength;
    if (change.rangeOffset > anchor) continue;
    if (anchor <= end) {
      anchor = change.rangeOffset + change.text.length;
    } else {
      anchor += change.text.length - change.rangeLength;
    }
  }
  return Math.max(0, anchor);
}

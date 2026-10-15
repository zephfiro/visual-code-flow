import type { SourceSpan, TextPosition } from '@visual-code-flow/shared';
import type { PhpNode } from './ast.js';

/** Coordinates of the exact editor snapshot: UTF-16, LF, CRLF and CR. */
export class PhpSource {
  private readonly starts: number[] = [0];
  private readonly ends: number[] = [];

  constructor(
    readonly uri: string,
    readonly text: string
  ) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      this.ends.push(i);
      if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
      this.starts.push(i + 1);
    }
    this.ends.push(text.length);
  }

  positionAt(offset: number): TextPosition {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.text.length) {
      throw new RangeError('Invalid PHP source offset');
    }
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low, character: Math.min(offset, this.ends[low]!) - this.starts[low]! };
  }

  offsetAt(position: TextPosition): number | undefined {
    const { line, character } = position;
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(character) ||
      line < 0 ||
      character < 0
    ) {
      return undefined;
    }
    const start = this.starts[line];
    const end = this.ends[line];
    return start === undefined || end === undefined || start + character > end
      ? undefined
      : start + character;
  }

  offsets(node: PhpNode): readonly [number, number] {
    const start = node.loc?.start.offset;
    const end = node.loc?.end.offset;
    if (
      start === undefined ||
      end === undefined ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.text.length
    ) {
      throw new RangeError('PHP AST source location is invalid');
    }
    return [start, end];
  }

  span(node: PhpNode): SourceSpan {
    const [start, end] = this.offsets(node);
    return { uri: this.uri, start: this.positionAt(start), end: this.positionAt(end) };
  }

  slice(node: PhpNode): string {
    const [start, end] = this.offsets(node);
    return this.text.slice(start, end);
  }
}

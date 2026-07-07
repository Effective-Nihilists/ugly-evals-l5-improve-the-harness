// Head+tail output truncation (ported from ugly-studio python-runtime/output-truncate.ts).
// Long output collapses to its first N + last M lines with an elision marker — the
// model needs both ends (start = context, tail = tracebacks / final results).
const HEAD_LINES = 100;
const TAIL_LINES = 50;
const MAX_BYTES = 200_000;

export function truncateOutput(text: string): string {
  if (text.length <= MAX_BYTES) {
    const lineCount = text.split('\n').length;
    if (lineCount <= HEAD_LINES + TAIL_LINES + 5) return text;
  }
  const lines = text.split('\n');
  if (lines.length <= HEAD_LINES + TAIL_LINES + 5) {
    // Byte-truncate the middle while preserving line boundaries.
    const head = text.slice(0, MAX_BYTES / 2);
    const tail = text.slice(text.length - MAX_BYTES / 2);
    return (
      head.slice(0, head.lastIndexOf('\n') + 1) +
      `\n... [truncated ${text.length - MAX_BYTES} bytes from the middle] ...\n` +
      tail.slice(tail.indexOf('\n') + 1)
    );
  }
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const dropped = lines.length - HEAD_LINES - TAIL_LINES;
  return (
    head.join('\n') +
    `\n... [truncated ${dropped} line${dropped === 1 ? '' : 's'}, showing first ${HEAD_LINES} and last ${TAIL_LINES}] ...\n` +
    tail.join('\n')
  );
}

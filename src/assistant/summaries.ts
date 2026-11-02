import type { AssistantSnapshot } from './types';
import { normalize } from './schema';

/** Old incremental notes are readable together until the next model update consolidates them. */
export function meetingMemo(snapshot: Pick<AssistantSnapshot, 'summary' | 'summaries'>): string {
  const latest = snapshot.summaries?.at(-1);
  if (latest?.format === 'memo') return snapshot.summary || latest.summary;
  if (!snapshot.summaries?.some((item) => item.format === 'incremental')) return snapshot.summary;
  const seen = new Set<string>();
  return snapshot.summaries
    .map((item) => item.summary)
    .filter((text) => {
      const key = normalize(text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n\n');
}

export interface MemoBlock {
  key: string;
  type: 'title' | 'heading' | 'paragraph' | 'list';
  lines: string[];
}
/** A small text-only format. Provider content never becomes HTML or executable links. */
export function memoBlocks(text: string): MemoBlock[] {
  const blocks: MemoBlock[] = [];
  let section = 'overview';
  let position = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^(#{1,2})\s+(.+)$/.exec(line);
    if (heading) {
      section = normalize(heading[2]);
      position = 0;
      blocks.push({
        key: `heading:${section}`,
        type: heading[1] === '#' ? 'title' : 'heading',
        lines: [heading[2]],
      });
    } else if (/^[-*]\s+/.test(line)) {
      const previous = blocks.at(-1);
      if (previous?.type === 'list') previous.lines.push(line.slice(2));
      else
        blocks.push({ key: `${section}:list:${position++}`, type: 'list', lines: [line.slice(2)] });
    } else {
      blocks.push({ key: `${section}:paragraph:${position++}`, type: 'paragraph', lines: [line] });
    }
  }
  // Repeated headings are still valid text and need distinct DOM keys.
  const counts = new Map<string, number>();
  return blocks.map((block) => {
    const count = counts.get(block.key) ?? 0;
    counts.set(block.key, count + 1);
    return { ...block, key: `${block.key}:${count}` };
  });
}

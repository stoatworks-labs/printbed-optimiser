// Advice, slicer warnings and notes, each with an icon and a word as well as a colour.
import type { ReactNode } from 'react';

export type Level = 'error' | 'warning' | 'info' | 'good';

const ICON: Record<Level, string> = { error: '✕', warning: '!', info: 'i', good: '✓' };
const WORD: Record<Level, string> = { error: 'Problem', warning: 'Warning', info: 'Note', good: 'OK' };

export function Message({ level, children, word = true }: { level: Level; children: ReactNode; word?: boolean }) {
  return (
    <li className={`msg ${level}`}>
      <span className="icon" aria-hidden="true">
        {ICON[level]}
      </span>
      {word ? <span className="lvl">{WORD[level]}:</span> : <span className="sr-only">{WORD[level]}:</span>}
      <span>{children}</span>
    </li>
  );
}

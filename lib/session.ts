import { NotebookCell } from './types';

const SESSION_KEY = 'lakehouse-analytics-session';

export function loadSession(): NotebookCell[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // Ignore parse errors
  }
  return [];
}

export function saveSession(cells: NotebookCell[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(cells));
  } catch {
    // Ignore storage quota errors
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SESSION_KEY);
}

export function generateCellId(): string {
  return `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

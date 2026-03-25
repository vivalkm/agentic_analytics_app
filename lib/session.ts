import { NotebookCell } from './types';

const SESSION_KEY = 'lakehouse-analytics-session';

/**
 * Strip large data from cells before persisting to localStorage.
 * Keeps columns/rowCount for display but drops rows to stay under the ~5MB quota.
 */
function stripRowsForStorage(cells: NotebookCell[]): NotebookCell[] {
  return cells.map((cell) => {
    if (!cell.metadata?.results) return cell;
    const { rows, ...rest } = cell.metadata.results;
    return {
      ...cell,
      metadata: {
        ...cell.metadata,
        results: { ...rest, rows: rows.slice(0, 5) },
      },
    };
  });
}

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
    localStorage.setItem(SESSION_KEY, JSON.stringify(stripRowsForStorage(cells)));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      console.warn('[session] localStorage quota exceeded — session not saved. Consider clearing old sessions.');
    }
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SESSION_KEY);
}

export function generateCellId(): string {
  return `cell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            An unexpected error occurred while rendering. You can try again or clear your session.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try Again
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                try {
                  // Only clear app-specific keys, not all localStorage
                  const keysToRemove: string[] = [];
                  for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key?.startsWith('cortex-') || key?.startsWith('lakehouse-')) {
                      keysToRemove.push(key);
                    }
                  }
                  keysToRemove.forEach((k) => localStorage.removeItem(k));
                } catch {}
                window.location.reload();
              }}
            >
              Clear Session
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

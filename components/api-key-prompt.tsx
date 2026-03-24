'use client';

import { useState } from 'react';
import { KeyRound, Loader2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ApiKeyPrompt({ onComplete }: { onComplete: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('API key is required');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const updates: Record<string, string> = { ANTHROPIC_API_KEY: apiKey.trim() };
      if (baseUrl.trim()) updates.ANTHROPIC_BASE_URL = baseUrl.trim();

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (res.ok) {
        onComplete();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Failed to connect to server');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 rounded-lg border bg-card p-8 shadow-lg">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Welcome to Lakehouse Analytics</h2>
            <p className="text-sm text-muted-foreground">Enter your Anthropic API key to get started</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">
              API Key <span className="text-destructive">*</span>
            </label>
            <Input
              type="password"
              placeholder="sk-ant-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
              autoFocus
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              Base URL <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Input
              type="text"
              placeholder="https://api.anthropic.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Only set this if using an API gateway or proxy
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                Get Started
                <ArrowRight className="h-4 w-4 ml-2" />
              </>
            )}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground mt-4 text-center">
          Your key is saved locally on this server in .env.local
        </p>
      </div>
    </div>
  );
}

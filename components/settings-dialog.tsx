'use client';

import { useState, useEffect, useCallback } from 'react';
import { Settings, Loader2, Check, Eye, EyeOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SettingValue {
  key: string;
  label: string;
  group: string;
  secret: boolean;
  placeholder?: string;
  value: string;
  hasValue: boolean;
}

const GROUP_LABELS: Record<string, string> = {
  llm: 'LLM (Anthropic)',
  trino: 'Trino',
  statsig: 'Statsig',
  github: 'GitHub',
};

const GROUP_ORDER = ['llm', 'trino', 'statsig', 'github'];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [settings, setSettings] = useState<SettingValue[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data.settings || []);
      setEdits({});
      setRevealedValues({});
      setSaved(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchSettings();
  }, [open, fetchSettings]);

  const handleSave = async () => {
    // Only send fields that were actually edited
    const updates: Record<string, string> = {};
    for (const [key, value] of Object.entries(edits)) {
      if (value !== undefined) {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      onOpenChange(false);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => onOpenChange(false), 800);
      }
    } finally {
      setSaving(false);
    }
  };

  const getDisplayValue = (setting: SettingValue): string => {
    // If user has edited this field, show their edit
    if (edits[setting.key] !== undefined) return edits[setting.key];
    // For secrets, show full value if revealed, masked otherwise
    if (setting.secret && setting.hasValue) {
      return revealedValues[setting.key] ?? setting.value; // revealed full value or masked from server
    }
    return setting.value;
  };

  const isRevealed = (key: string) => key in revealedValues;

  const toggleReveal = async (key: string) => {
    if (isRevealed(key)) {
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } else {
      try {
        const res = await fetch(`/api/settings?reveal=${encodeURIComponent(key)}`);
        const data = await res.json();
        if (data.value !== undefined) {
          setRevealedValues((prev) => ({ ...prev, [key]: data.value }));
        }
      } catch {
        // silently fail — keep masked
      }
    }
  };

  // Group settings
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: settings.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure your API keys and preferences. Changes are saved to the server.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6 py-2">
            {grouped.map(({ group, label, items }) => (
              <div key={group}>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">
                  {label}
                </h3>
                <div className="space-y-3">
                  {items.map((setting) => (
                    <div key={setting.key}>
                      <label className="text-sm font-medium mb-1 block">
                        {setting.label}
                        {setting.key === 'ANTHROPIC_API_KEY' && (
                          <span className="text-destructive ml-1">*</span>
                        )}
                      </label>
                      <div className="relative">
                        <Input
                          type={setting.secret && !isRevealed(setting.key) ? 'password' : 'text'}
                          placeholder={setting.placeholder}
                          value={getDisplayValue(setting)}
                          onChange={(e) =>
                            setEdits((prev) => ({ ...prev, [setting.key]: e.target.value }))
                          }
                          className="pr-10 font-mono text-sm"
                        />
                        {setting.secret && setting.hasValue && (
                          <button
                            type="button"
                            onClick={() => toggleReveal(setting.key)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            {isRevealed(setting.key) ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || saved}>
            {saved ? (
              <>
                <Check className="h-4 w-4 mr-1" />
                Saved
              </>
            ) : saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Saving...
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

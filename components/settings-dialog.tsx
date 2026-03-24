'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

interface SettingsFormData {
  trinoCatalog: string;
  trinoPrioritySchemas: string;
  trinoPriorityTables: string;
  trinoSkipSchemas: string;
  statsigApiKey: string;
  statsigMetricTeams: string;
  anthropicApiKey: string;
  anthropicModel: string;
  queryLibraryRepo: string;
  githubToken: string;
}

const EMPTY_FORM: SettingsFormData = {
  trinoCatalog: '',
  trinoPrioritySchemas: '',
  trinoPriorityTables: '',
  trinoSkipSchemas: '',
  statsigApiKey: '',
  statsigMetricTeams: '',
  anthropicApiKey: '',
  anthropicModel: '',
  queryLibraryRepo: '',
  githubToken: '',
};

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [form, setForm] = useState<SettingsFormData>(EMPTY_FORM);
  const [defaults, setDefaults] = useState<SettingsFormData>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load current settings when dialog opens
  useEffect(() => {
    if (!open) return;
    setSaved(false);
    setLoading(true);
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        // Effective config (with masked secrets) used as placeholders
        setDefaults(data.effective || EMPTY_FORM);
        // User overrides (with masked secrets) used as initial values
        const overrides = data.overrides || {};
        setForm({
          trinoCatalog: overrides.trinoCatalog || '',
          trinoPrioritySchemas: overrides.trinoPrioritySchemas || '',
          trinoPriorityTables: overrides.trinoPriorityTables || '',
          trinoSkipSchemas: overrides.trinoSkipSchemas || '',
          // Don't pre-fill masked secrets — user must re-enter to change
          statsigApiKey: '',
          statsigMetricTeams: overrides.statsigMetricTeams || '',
          anthropicApiKey: '',
          anthropicModel: overrides.anthropicModel || '',
          queryLibraryRepo: overrides.queryLibraryRepo || '',
          githubToken: '',
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only send non-empty values (empty = use default)
      const payload: Record<string, string> = {};
      for (const [key, value] of Object.entries(form)) {
        if (value.trim()) payload[key] = value.trim();
      }
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSaved(true);
      setTimeout(() => onOpenChange(false), 800);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const update = (key: keyof SettingsFormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
    setSaved(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Override default configuration. Leave blank to use the server default.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Trino */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Trino</h3>
              <Field label="Default Catalog" value={form.trinoCatalog} placeholder={defaults.trinoCatalog} onChange={update('trinoCatalog')} />
              <Field label="Priority Schemas" value={form.trinoPrioritySchemas} placeholder={defaults.trinoPrioritySchemas || 'comma-separated'} onChange={update('trinoPrioritySchemas')} />
              <Field label="Priority Tables" value={form.trinoPriorityTables} placeholder={defaults.trinoPriorityTables || 'catalog.schema.table, ...'} onChange={update('trinoPriorityTables')} />
              <Field label="Skip Schemas" value={form.trinoSkipSchemas} placeholder={defaults.trinoSkipSchemas} onChange={update('trinoSkipSchemas')} />
            </section>

            <Separator />

            {/* Statsig */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Statsig Metrics</h3>
              <Field label="Console API Key" value={form.statsigApiKey} placeholder={defaults.statsigApiKey || 'not set'} onChange={update('statsigApiKey')} type="password" />
              <Field label="Metric Teams" value={form.statsigMetricTeams} placeholder={defaults.statsigMetricTeams} onChange={update('statsigMetricTeams')} />
            </section>

            <Separator />

            {/* LLM */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">LLM</h3>
              <Field label="Anthropic API Key" value={form.anthropicApiKey} placeholder={defaults.anthropicApiKey || 'not set'} onChange={update('anthropicApiKey')} type="password" />
              <Field label="Model" value={form.anthropicModel} placeholder={defaults.anthropicModel || 'default'} onChange={update('anthropicModel')} />
            </section>

            <Separator />

            {/* GitHub */}
            <section className="space-y-3">
              <h3 className="text-sm font-medium">GitHub Query Library</h3>
              <Field label="Repository URL" value={form.queryLibraryRepo} placeholder={defaults.queryLibraryRepo || 'https://github.com/...'} onChange={update('queryLibraryRepo')} />
              <Field label="GitHub Token" value={form.githubToken} placeholder={defaults.githubToken || 'not set'} onChange={update('githubToken')} type="password" />
            </section>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : saved ? (
                  'Saved!'
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      <Input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
    </div>
  );
}

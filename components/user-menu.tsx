'use client';

import { useSession, signOut } from 'next-auth/react';
import { useState } from 'react';
import { LogOut, Settings } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsDialog } from '@/components/settings-dialog';
import { useAuthEnabled } from '@/components/session-wrapper';

export function UserMenu() {
  const authEnabled = useAuthEnabled();

  if (!authEnabled) {
    return <SettingsOnlyMenu />;
  }

  return <AuthUserMenu />;
}

function SettingsOnlyMenu() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setSettingsOpen(true)}
        className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Settings className="h-4 w-4" />
        <span className="hidden sm:inline">Settings</span>
      </button>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

function AuthUserMenu() {
  const { data: session } = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (!session?.user) return null;

  const name = session.user.name || 'User';
  const email = session.user.email || '';
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
            {initials}
          </span>
          <span className="hidden sm:inline">{name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{email}</p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut()}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

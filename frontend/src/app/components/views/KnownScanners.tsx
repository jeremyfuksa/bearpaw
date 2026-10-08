import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getAPI } from '../../../api/useApi';
import { useStore } from '../../../store/useStore';
import type { ScannerProfile } from '../../../types';
import { formatAge, formatSyncedAt } from '../ScannerUI';

const DISPLAY_NAME_MAX_CHARS = 64;

function label(profile: ScannerProfile): string {
  return profile.display_name || profile.model;
}

/**
 * The scanner profiles Bearpaw knows (#417), at the top of the Device tab.
 *
 * With one profile this is a single line naming the scanner -- most users own
 * one radio and always will, so a list widget with one row would be noise. It
 * grows into a list only once a second profile exists.
 *
 * The list is KNOWN profiles, not available devices: only one scanner is
 * connected at a time, and hot-swap picks the profile on plug-in. So rows are
 * not clickable. An unplugged one says how to use it instead of offering a
 * control that cannot work.
 */
export function KnownScanners() {
  const scannerId = useStore((state) => state.deviceInfo?.scanner_id);
  const connectionStatus = useStore((state) => state.deviceInfo?.connection_status);
  const displayName = useStore((state) => state.deviceInfo?.display_name);
  const [profiles, setProfiles] = useState<ScannerProfile[]>([]);

  // Refetch whenever the connected scanner, its state, or its name changes. A
  // rename of the loaded profile arrives as a `device_info` broadcast, so this
  // also picks up a rename made elsewhere.
  useEffect(() => {
    let cancelled = false;
    getAPI()
      .getScanners()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch((error) => {
        // Offline-first: a failed read leaves the Device tab as it was.
        console.warn('Failed to load scanner profiles', error);
      });
    return () => {
      cancelled = true;
    };
  }, [scannerId, connectionStatus, displayName]);

  const rename = async (profile: ScannerProfile, name: string) => {
    try {
      const result = await getAPI().renameScanner(profile.scanner_id, name || null);
      setProfiles((list) =>
        list.map((p) =>
          p.scanner_id === profile.scanner_id ? { ...p, display_name: result.display_name } : p,
        ),
      );
    } catch (error) {
      console.error('Failed to rename scanner', error);
      toast.error(`Couldn't rename ${label(profile)}`);
    }
  };

  if (profiles.length === 0) return null;

  if (profiles.length === 1) {
    return (
      <div className="mb-4 border-b border-white/10 pb-4 text-sm">
        <ProfileLine profile={profiles[0]} onRename={rename} />
      </div>
    );
  }

  return (
    <section
      aria-labelledby="known-scanners-heading"
      className="mb-4 border-b border-white/10 pb-4"
    >
      <h4
        id="known-scanners-heading"
        className="mb-2 text-xs font-bold uppercase tracking-wider text-white/60"
      >
        Known scanners
      </h4>
      <ul className="space-y-2 text-sm">
        {profiles.map((profile) => (
          <li key={profile.scanner_id} aria-current={profile.connected ? 'true' : undefined}>
            <ProfileLine profile={profile} onRename={rename} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ProfileLineProps {
  profile: ScannerProfile;
  onRename: (profile: ScannerProfile, name: string) => Promise<void>;
}

function ProfileLine({ profile, onRename }: ProfileLineProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const renameButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // Focus goes back to the Rename button once the field closes, so a keyboard
  // user is not dropped at the top of the page.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      renameButton.current?.focus();
    }
  }, [editing]);

  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  const save = async () => {
    const name = draft.trim();
    if (name !== (profile.display_name ?? '')) await onRename(profile, name);
    close();
  };

  const synced = formatSyncedAt(profile.synced_at);
  const status = profile.connected
    ? 'Connected'
    : `Not connected · last seen ${formatAge(profile.last_seen) ?? 'never'}`;

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex items-center gap-2"
      >
        <input
          autoFocus
          value={draft}
          maxLength={DISPLAY_NAME_MAX_CHARS}
          aria-label={`Name for this ${profile.model}`}
          placeholder={profile.model}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          className="scanner-input min-w-0 flex-1 rounded px-2 py-1 text-sm"
        />
        <button type="submit" className="text-brand-primary hover:underline">
          Save
        </button>
        <button type="button" onClick={close} className="text-white/60 hover:text-white">
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {profile.connected && (
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 self-center rounded-full bg-brand-primary shadow-glow"
        />
      )}
      <span className="font-semibold text-white">{label(profile)}</span>
      {profile.display_name && <span className="text-white/60">{profile.model}</span>}
      <span className={profile.connected ? 'text-brand-primary' : 'text-white/60'}>{status}</span>
      {synced && <span className="text-white/60">{synced}</span>}
      <button
        ref={renameButton}
        type="button"
        onClick={() => {
          setDraft(profile.display_name ?? '');
          setEditing(true);
        }}
        aria-label={`Rename ${label(profile)}`}
        className="ml-auto text-brand-primary/80 hover:text-brand-primary"
      >
        Rename
      </button>
      {!profile.connected && (
        <p className="basis-full text-xs text-white/60">Plug it in to use it.</p>
      )}
    </div>
  );
}

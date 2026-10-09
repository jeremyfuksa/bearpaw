import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { APIError } from '../../../api/client';
import { getAPI } from '../../../api/useApi';
import { useStore } from '../../../store/useStore';
import { confirmDialog } from '../../../tauri-shell';
import type { ScannerProfile } from '../../../types';
import { formatAge, formatSyncedAt } from '../ScannerUI';

const DISPLAY_NAME_MAX_CHARS = 64;

function label(profile: ScannerProfile): string {
  return profile.display_name || profile.model;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Says exactly what Forget deletes (#417). Never "settings": scanner settings
 * are read live from the radio and never stored (#415), so there are none to
 * forget. Activity history is keyed by model, so it is only deleted when no
 * other profile shares the model.
 */
export function forgetMessage(profile: ScannerProfile): string {
  const parts = [
    profile.channels > 0 && plural(profile.channels, 'cached channel'),
    profile.bank_names > 0 && plural(profile.bank_names, 'bank name'),
  ].filter(Boolean);
  const stored = parts.length
    ? `Bearpaw deletes the ${parts.join(' and ')} it stored for this scanner.`
    : 'Bearpaw has no channels or bank names stored for this scanner.';
  const history = profile.history_shared
    ? `Activity history stays, because it is shared with your other ${profile.model}.`
    : 'Its activity history is deleted.';
  return `Forget ${label(profile)}? ${stored} ${history} The scanner's own memory is not changed.`;
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
  const container = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);

  // A forgotten row takes its focused Forget button with it. Put focus back on
  // the block so a keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (refocus.current) {
      refocus.current = false;
      container.current?.focus();
    }
  }, [profiles]);

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

  const forget = async (profile: ScannerProfile) => {
    if (!(await confirmDialog(forgetMessage(profile), `Forget ${label(profile)}`))) return;
    try {
      await getAPI().forgetScanner(profile.scanner_id);
      refocus.current = true;
      setProfiles((list) => list.filter((p) => p.scanner_id !== profile.scanner_id));
      toast.success(`Forgot ${label(profile)}`);
    } catch (error) {
      console.error('Failed to forget scanner', error);
      // 409: it became the loaded profile after this list was read (it was
      // plugged in while the dialog was open).
      toast.error(
        error instanceof APIError && error.status === 409
          ? `Couldn't forget ${label(profile)}: it's the scanner in use`
          : `Couldn't forget ${label(profile)}`,
      );
    }
  };

  if (profiles.length === 0) return null;

  if (profiles.length === 1) {
    return (
      <div
        ref={container}
        tabIndex={-1}
        className="mb-4 border-b border-white/10 pb-4 text-sm outline-none"
      >
        <ProfileLine profile={profiles[0]} onRename={rename} onForget={forget} />
      </div>
    );
  }

  return (
    <section
      ref={container}
      tabIndex={-1}
      aria-labelledby="known-scanners-heading"
      className="mb-4 border-b border-white/10 pb-4 outline-none"
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
            <ProfileLine profile={profile} onRename={rename} onForget={forget} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ProfileLineProps {
  profile: ScannerProfile;
  onRename: (profile: ScannerProfile, name: string) => Promise<void>;
  onForget: (profile: ScannerProfile) => Promise<void>;
}

function ProfileLine({ profile, onRename, onForget }: ProfileLineProps) {
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
      {/* Hidden, not disabled, on the LOADED profile -- connected or merely
          unplugged. Its channels are still in use and the cache flush would
          write them straight back, so the API refuses it (409). */}
      {!profile.loaded && (
        <button
          type="button"
          onClick={() => void onForget(profile)}
          aria-label={`Forget ${label(profile)}`}
          className="text-red-400/80 hover:text-red-400"
        >
          Forget
        </button>
      )}
      {!profile.connected && (
        <p className="basis-full text-xs text-white/60">Plug it in to use it.</p>
      )}
    </div>
  );
}

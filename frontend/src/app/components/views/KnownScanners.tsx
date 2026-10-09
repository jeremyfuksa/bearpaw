import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { APIError } from '../../../api/client';
import { getAPI } from '../../../api/useApi';
import { cn } from '../../../lib/utils';
import { useStore } from '../../../store/useStore';
import { confirmDialog } from '../../../tauri-shell';
import type { ScannerProfile } from '../../../types';
import { formatAge } from '../ScannerUI';

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
    !profile.history_shared && 'activity history',
  ].filter((part): part is string => Boolean(part));
  const list =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  // No "Forget X?" opener: the dialog title already says it.
  const sentences: string[] = [];
  if (list) sentences.push(`This deletes its ${list} from Bearpaw.`);
  if (profile.history_shared) {
    sentences.push(`Activity history stays, because your other ${profile.model} shares it.`);
  }
  sentences.push("The scanner itself isn't changed.");
  return sentences.join(' ');
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
 * not clickable.
 *
 * The single line shows no status: the Status row just below says it.
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
      {/* One grid shared by every row (via subgrid): model, name, status,
          Forget, Rename. Model comes first because every scanner has one, so
          an unnamed row has no blank leading cell. The status column takes the
          slack, pushing the buttons to the right edge. */}
      <ul className="grid grid-cols-[auto_auto_1fr_auto_auto] gap-x-4 gap-y-2 text-sm">
        {profiles.map((profile) => (
          <li
            key={profile.scanner_id}
            aria-current={profile.connected ? 'true' : undefined}
            className="col-span-full grid grid-cols-subgrid"
          >
            <ProfileLine profile={profile} onRename={rename} onForget={forget} inList />
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
  /**
   * A row of the multi-profile list: adds the connection status (the single
   * line omits it, since the Status row below says it) and lays the line out
   * on the list's column grid, with an empty cell wherever a row lacks a piece.
   */
  inList?: boolean;
}

function ProfileLine({ profile, onRename, onForget, inList = false }: ProfileLineProps) {
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

  // In the list every cell is rendered, empty where this row has nothing, so
  // the next cell stays in its column.
  const empty = inList ? <span aria-hidden /> : null;

  const modelCell = <span className="text-white/70">{profile.model}</span>;
  const nameCell = profile.display_name ? (
    <span className="max-w-[16rem] truncate font-semibold text-white">{profile.display_name}</span>
  ) : (
    empty
  );
  // The dot belongs to "Connected", so they share a cell. No sync age: a
  // connect re-reads memory by default, so it repeats "last seen" on every
  // unplugged row, and the status bar shows it for the connected scanner.
  // An unplugged row keeps an empty dot-sized slot so both status texts start
  // at the same x.
  const statusCell = (
    <span
      className={cn(
        'flex items-center gap-1.5',
        profile.connected ? 'text-brand-primary' : 'text-white/60',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          profile.connected && 'bg-brand-primary shadow-glow',
        )}
      />
      {profile.connected ? 'Connected' : `Last seen ${formatAge(profile.last_seen) ?? 'never'}`}
    </span>
  );

  if (editing) {
    if (!inList) {
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex items-center gap-2"
        >
          {modelCell}
          <NameInput profile={profile} draft={draft} onChange={setDraft} onCancel={close} />
          <button type="button" onClick={close} className="text-white/60 hover:text-white">
            Cancel
          </button>
          <button type="submit" className="text-brand-primary hover:underline">
            Save
          </button>
        </form>
      );
    }
    // In the list the field stays on the column grid: the model stays put, the
    // input covers the name and status columns, Cancel sits under Forget and
    // Save under Rename. Invisible copies of the covered cells keep sizing
    // their columns, so the other rows do not move while this one is edited.
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="col-span-full grid grid-cols-subgrid items-center"
      >
        <span className="col-start-1 row-start-1">{modelCell}</span>
        <span aria-hidden className="invisible col-start-2 row-start-1 h-0">
          {nameCell}
        </span>
        <span aria-hidden className="invisible col-start-3 row-start-1 h-0">
          {statusCell}
        </span>
        <NameInput
          profile={profile}
          draft={draft}
          onChange={setDraft}
          onCancel={close}
          className="col-span-2 col-start-2 row-start-1"
        />
        <button
          type="button"
          onClick={close}
          className="col-start-4 row-start-1 justify-self-start text-white/60 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="col-start-5 row-start-1 justify-self-start text-brand-primary hover:underline"
        >
          Save
        </button>
      </form>
    );
  }

  return (
    <div
      className={
        inList
          ? 'col-span-full grid grid-cols-subgrid items-baseline'
          : 'flex flex-wrap items-baseline gap-x-3 gap-y-1'
      }
    >
      {modelCell}
      {nameCell}
      {inList && statusCell}
      {/* Forget comes BEFORE Rename so Rename, on every row, sits at the same
          right edge. Hidden, not disabled, on the LOADED profile -- connected
          or merely unplugged. Its channels are still in use and the cache
          flush would write them straight back, so the API refuses it (409). */}
      {!profile.loaded ? (
        <button
          type="button"
          onClick={() => void onForget(profile)}
          aria-label={`Forget ${label(profile)}`}
          className={cn('text-red-400/80 hover:text-red-400', !inList && 'ml-auto')}
        >
          Forget
        </button>
      ) : (
        empty
      )}
      <button
        ref={renameButton}
        type="button"
        onClick={() => {
          setDraft(profile.display_name ?? '');
          setEditing(true);
        }}
        aria-label={`Rename ${label(profile)}`}
        className={cn(
          'text-brand-primary/80 hover:text-brand-primary',
          !inList && profile.loaded && 'ml-auto',
        )}
      >
        Rename
      </button>
    </div>
  );
}

interface NameInputProps {
  profile: ScannerProfile;
  draft: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

function NameInput({ profile, draft, onChange, onCancel, className }: NameInputProps) {
  return (
    <input
      autoFocus
      value={draft}
      maxLength={DISPLAY_NAME_MAX_CHARS}
      aria-label={`Name for this ${profile.model}`}
      placeholder={profile.model}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className={cn('scanner-input min-w-0 flex-1 rounded px-2 py-1 text-sm', className)}
    />
  );
}

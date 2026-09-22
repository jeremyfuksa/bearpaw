import { readFileSync } from 'fs';
import path from 'path';
import viteConfig from '../../vite.config';

// REGRESSION GUARD (#679): a startup failure shows a message, never a blank
// window. The script under test is the real one, extracted from index.html --
// a copy here would pass whether or not the shipped page still had it.

const frontendRoot = path.resolve(__dirname, '../..');
const indexHtml = readFileSync(path.join(frontendRoot, 'index.html'), 'utf-8');

// Parsed, not pattern-matched: a regex over HTML misses <SCRIPT>, attributes
// and comments (CodeQL js/bad-tag-filter). The startup script is the one
// inline, non-module script in the document.
function startupScript(): string {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html');
  const script = Array.from(doc.querySelectorAll('script')).find(
    (s) => !s.src && s.type !== 'module',
  );
  if (!script?.textContent) throw new Error('index.html has no inline startup-failure script');
  return script.textContent;
}

function load() {
  document.body.innerHTML = '<div id="root"></div>';
  new Function(startupScript())();
}

function rootText(): string {
  return document.getElementById('root')!.textContent ?? '';
}

describe('startup failure screen (#679)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.__bearpawStarted;
    delete window.__bearpawStartupFailureShown;
    delete window.__bearpawShowStartupFailure;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replaces the blank window when the app fails before it starts', () => {
    load();
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: "SyntaxError: Unexpected token '{'",
        error: new SyntaxError("Unexpected token '{'"),
      }),
    );
    expect(rootText()).toContain("Bearpaw couldn't start its window.");
    expect(rootText()).toContain("Unexpected token '{'");
    expect(rootText()).toContain(navigator.userAgent);
  });

  it('stays out of the way once the app has started', () => {
    load();
    window.__bearpawStarted = true;
    window.dispatchEvent(new ErrorEvent('error', { message: 'a later, handled error' }));
    vi.advanceTimersByTime(30000);
    expect(rootText()).toBe('');
  });

  it('reports a web view that fails silently', () => {
    load();
    vi.advanceTimersByTime(19999);
    expect(rootText()).toBe('');
    vi.advanceTimersByTime(1);
    expect(rootText()).toContain('did not start within 20 seconds');
  });

  it('is written for a web view too old for the app', () => {
    // The script's whole job is to run where the app's own bundle cannot. ES6+
    // syntax here would fail on exactly the machines it exists for.
    const script = startupScript();
    expect(script).not.toMatch(/=>|\bconst\b|\blet\b|`|\?\.|\?\?|\bclass\b/);
  });
});

describe('build target (#679)', () => {
  it('transpiles for the declared macOS floor instead of shipping esnext', () => {
    const target = viteConfig.build?.target;
    expect(target).not.toBe('esnext');
    expect(target).toEqual(expect.arrayContaining(['safari15']));

    const tauri = JSON.parse(
      readFileSync(path.join(frontendRoot, 'src-tauri/tauri.conf.json'), 'utf-8'),
    );
    // 10.15 is the oldest macOS that gets Safari 15.4, which the bundle's
    // Object.hasOwn / Array.prototype.at calls require. Older macOS would
    // install the app and show the startup-failure screen; the OS should
    // refuse the launch instead.
    expect(tauri.bundle.macOS.minimumSystemVersion).toBe('10.15');
  });
});

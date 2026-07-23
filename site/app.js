const REPO = 'jeremyfuksa/bearpaw';

// Order matters: first pattern that matches an asset name wins its slot.
const PLATFORMS = [
  { key: 'mac-arm', label: 'macOS · Apple Silicon', pattern: /aarch64\.dmg$/ },
  { key: 'mac-intel', label: 'macOS · Intel', pattern: /x64\.dmg$/ },
  { key: 'windows', label: 'Windows', pattern: /(-setup\.exe|\.msi)$/ },
  { key: 'linux-appimage', label: 'Linux · AppImage', pattern: /\.AppImage$/ },
  { key: 'linux-deb', label: 'Linux · Debian/Ubuntu', pattern: /\.deb$/ },
];

function detectPlatformKey() {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'windows';
  // Browsers don't reliably expose Apple Silicon vs Intel; Apple Silicon has
  // been the default Mac since 2020, so promote it and list Intel alongside.
  if (/Macintosh/.test(ua)) return 'mac-arm';
  if (/Linux/.test(ua)) return 'linux-appimage';
  return null;
}

async function loadRelease() {
  const versionEl = document.getElementById('release-version');
  const primaryEl = document.getElementById('download-primary');
  const listEl = document.getElementById('asset-list');

  try {
    // Not /releases/latest: that endpoint ignores prereleases, and betas are
    // all this project has shipped so far.
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=5`);
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const releases = await res.json();
    const release = releases.find((r) => !r.draft);
    if (!release) throw new Error('no published releases');

    const found = PLATFORMS.map((p) => {
      const asset = release.assets.find((a) => p.pattern.test(a.name));
      return asset ? { ...p, asset } : null;
    }).filter(Boolean);

    if (found.length === 0) throw new Error('no installer assets in latest release');

    versionEl.textContent = `Latest release: ${release.tag_name}`;

    const mine = found.find((p) => p.key === detectPlatformKey());
    if (mine) {
      primaryEl.innerHTML = '';
      const btn = document.createElement('a');
      btn.className = 'btn btn-primary';
      btn.href = mine.asset.browser_download_url;
      btn.textContent = `Download for ${mine.label}`;
      primaryEl.appendChild(btn);
    }

    listEl.innerHTML = '';
    for (const p of found) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = p.asset.browser_download_url;
      const name = document.createElement('span');
      name.textContent = p.asset.name;
      const platform = document.createElement('span');
      platform.className = 'asset-platform';
      platform.textContent = p.label;
      a.append(name, platform);
      li.appendChild(a);
      listEl.appendChild(li);
    }
  } catch {
    // Rate-limited, offline, or an unexpected release shape: leave the static
    // Releases-page button in place and say so instead of showing a spinner.
    versionEl.textContent = 'Latest release: see GitHub Releases';
  }
}

loadRelease();

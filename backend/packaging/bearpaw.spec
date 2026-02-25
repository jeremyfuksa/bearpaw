# PyInstaller spec for Bearpaw
# Build: pyinstaller --clean --noconfirm backend/packaging/bearpaw.spec

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = collect_submodules("bearpaw")

block_cipher = None


a = Analysis(
    ["backend/src/bearpaw/main.py"],
    pathex=["."],
    binaries=[],
    datas=[("backend/config.example.yaml", "config")],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="bearpaw",
    console=True,
)

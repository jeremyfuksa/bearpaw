# Bearpaw — frontend

The React frontend for [Bearpaw](../README.md), a desktop control interface for
the Uniden BC125AT scanner. This is a Vite single-page app (React 18 +
TypeScript, Zustand for state) that displays live scanner state and sends
commands to the Rust backend.

The architecture is strictly client/server: the backend owns all state and
hardware communication, and this frontend only renders current state and issues
commands over REST + WebSocket. It does not talk to the scanner directly.

## Prerequisites

The UI needs the Bearpaw backend running to do anything — on its own it renders
a disconnected shell. Start the backend first (from the repo root):

```bash
cargo run -p bearpaw-api --bin bearpaw -- --config ./config.yaml
```

The dev server proxies `/api` and `/ws` to the backend at `localhost:8000`.

## Development

```bash
npm install
npm run dev              # Vite dev server with HMR
npm run build            # production build
```

### Checks

```bash
npm test -- --run        # Vitest (one-shot)
npm run lint             # ESLint
npm run type-check       # tsc --noEmit (src/ only; test files excluded)
npm run format:check     # Prettier
```

See [TESTING.md](TESTING.md) for the testing setup.

## Desktop app (Tauri)

Tauri 2 bundles this frontend and the Rust backend into a single desktop app:

```bash
npm run tauri:dev        # dev mode with HMR
npm run tauri:build      # bundle for release
```

## Configuration

Two environment variables, set in `frontend/.env`:

```
VITE_API_BASE_URL=/api/v1
VITE_WS_URL=                # auto-detect from window.location if empty
```

## Attributions

See [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

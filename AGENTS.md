# Repository Guidelines

## Project Structure
- `backend/`: Python FastAPI service (`backend/src/scanner_bridge`) with tests in `backend/tests` and configs like `backend/config.yaml`.
- `frontend/`: React + TypeScript app (Vite). Source in `frontend/src`, assets in `frontend/public`.
- `docs/`: Specs, API contract, and workflow notes (start with `docs/README.md`).

## Build, Test, and Development Commands
Backend (run from `backend/`):
- `python -m venv venv && source venv/bin/activate`: create and activate the local virtual environment.
- `pip install -r requirements.txt`: install backend dependencies.
- `scanner-bridge --config ./config.yaml`: run the backend service.
- `python -m unittest discover -s tests`: run backend tests.

Frontend (run from `frontend/`):
- `npm install`: install frontend dependencies.
- `npm run dev`: start the Vite dev server.
- `npm run build`: type-check and build production assets.
- `npm run lint` / `npm run format`: lint and format the codebase.

## Coding Style & Naming Conventions
- Python: 4-space indentation, standard library `unittest` style in `backend/tests`.
- TypeScript/React: 2-space indentation, components in `frontend/src/components`, hooks in `frontend/src/hooks`, API code in `frontend/src/api`.
- Use existing module naming patterns (e.g., `useWebSocket`, `ScannerWebSocket`).

## Testing Guidelines
- Backend tests use `unittest` and live in `backend/tests` with `test_*.py` naming.
- Frontend tests are not yet defined; keep changes testable and add tests when frameworks are introduced.

## Commit & Pull Request Guidelines
- Recent commits use imperative summaries (e.g., "Implement...", "Remove..."); follow this style.
- PRs should include a short description, linked issue (if any), and screenshots for UI changes.

## Configuration & Docs
- Copy `backend/config.example.yaml` to `backend/config.yaml` for local settings.
- Follow the API contract in `docs/API_SPEC.md` and keep specs updated when behavior changes.

## Python Environment Rule
- Always use a venv located in the project folder (`backend/venv`).
- Use `pip` inside the activated venv; do not use system-wide installs.

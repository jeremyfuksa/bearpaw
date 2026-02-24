# Repository Guidelines

## Project Structure
- `backend/`: Python FastAPI service (`backend/src/scanner_bridge`) with tests in `backend/tests`, configs in `backend/*.yaml`.
- `frontend/`: React + TypeScript app (Vite). Source in `frontend/src`, assets in `frontend/public`.
- `docs/`: Specs, API contract, and workflow notes (start with `docs/README.md`).

## Build, Test, and Development Commands
Backend (run from `backend/`):
- `source .venv/bin/activate`: activate virtual environment (venv is in `.venv/`, NOT `venv/`).
- `pip install -e .`: install backend in editable mode.
- `scanner-bridge --config ./config.yaml`: run the backend service.
- `python -m unittest discover -s tests`: run all backend tests.
- `python -m unittest tests.test_api.ApiTests.test_status`: run a single backend test.

Frontend (run from `frontend/`):
- `npm install`: install frontend dependencies.
- `npm run dev`: start the Vite dev server (port 5173).
- `npm run build`: type-check and build production assets.
- `npm run test`: run frontend tests with Vitest.
- `npm run test:ui`: run frontend tests with UI.
- `npm run test:coverage`: run tests with coverage report.

Root (Tauri desktop app):
- `npm run dev`: start backend and frontend together.
- `npm run tauri:dev`: start Tauri development mode.
- `npm run build`: build all components (frontend + backend + Tauri).

## Python Code Style
- **Indentation**: 4 spaces (always, no tabs).
- **Imports**: Group into four blocks: 1) `from __future__ import annotations`, 2) stdlib imports, 3) third-party imports, 4) local imports. Separate each block with a blank line. Sort alphabetically within each group.
- **Type Hints**: Use type hints for all function signatures; prefer `list[T]` over `List[T]` for collections. Use `Optional[T]` for nullable types.
- **Async/Await**: Use `async def` for I/O operations; all driver methods in protocol layer must be async.
- **Error Handling**: Raise `HTTPException` from FastAPI for API errors; use `raise ... from exc` to chain exceptions. Wrap driver calls in try/except and convert to HTTPException with appropriate status codes.
- **Logging**: Use the `logging` module with `logger = logging.getLogger(__name__)`. Log exceptions with `logger.exception()`, debug with `logger.debug()`, info with `logger.info()`.
- **Data Models**: Use Pydantic `BaseModel` for API request/response models; use `@dataclass` for internal state and data transfer objects. Set `model_config = {"from_attributes": True}` on Pydantic models that wrap dataclasses.
- **Abstract Classes**: Use `ABC` and `@abstractmethod` for protocol interfaces; all driver classes inherit from `ScannerDriver` base class.
- **Testing**: Use `unittest.TestCase` for sync tests, `unittest.IsolatedAsyncioTestCase` for async tests. Create stub classes (e.g., `StubDriver`, `StubScheduler`) for mocking external dependencies.

## TypeScript/React Code Style
- **Indentation**: 2 spaces (always, no tabs).
- **Components**: Functional components with hooks; use named exports: `export function ComponentName() {}`. Define prop interfaces above the component with same name + "Props" suffix.
- **Types**: Define interfaces in `src/types.ts` for shared data structures. Use `type` for unions/aliases and `interface` for object shapes. Export types used across modules.
- **Styling**: Use Tailwind CSS classes exclusively; wrap class names with `cn()` utility from `@/lib/utils` for conditional classes. Follow existing design patterns in shadcn/ui components.
- **State Management**: Use Zustand store in `src/store/` for global state; create custom hooks in `src/hooks/` for component-level logic. Avoid prop drilling for shared state.
- **Imports**: Use absolute imports with `@/` alias: `import { X } from "@/components/ui/x"` or `import { Y } from "@/lib/y"`. Order imports: React, third-party, local (with absolute paths), type imports.
- **Error Handling**: Throw `APIError` class (defined in `src/api/client.ts`) for API failures; handle with try/catch in components and display user-friendly errors. Use toast notifications for user feedback via `useNotifications` hook.
- **Event Handlers**: Define handlers as functions outside component when possible, or use `useCallback` for callbacks that depend on props/state.
- **Testing**: Use Vitest with `@testing-library/react`. Tests belong in `src/**/__tests__/**/*.{test,spec}.{ts,tsx}`. Write tests that verify user behavior, not implementation details.

## Naming Conventions
- Python: snake_case for functions/variables, PascalCase for classes, UPPER_SNAKE for constants. File names: snake_case.py.
- TypeScript: PascalCase for components/functions, camelCase for variables, kebab-case for files.
- File naming: `kebab-case.ts` for utilities, `PascalCase.tsx` for components. Test files: `ComponentName.test.tsx` or `component-name.test.ts`.
- Backend modules: `module_name.py`, package: `scanner_bridge.module_name`.
- Frontend paths: `kebab-case/` for directories, matching file names where possible.

## Testing Guidelines
- Backend tests: Located in `backend/tests/test_*.py`. Use `unittest.TestCase` for sync tests and `unittest.IsolatedAsyncioTestCase` for async tests. Mock external dependencies with stub classes. Test both happy paths and error cases.
- Frontend tests: Located in `src/**/__tests__/**/*.{test,spec}.{ts,tsx}`. Use `@testing-library/react` for component testing. Query elements using accessible queries (`getByRole`, `getByLabelText`) over `getByTestId`.
- Run single backend test: `python -m unittest tests.test_module.TestClass.test_method`
- Run single frontend test: `npm run test -- path/to/test.test.tsx -t "test name"`
- Backend tests stub external hardware/drivers; frontend tests mock API calls using `vi.fn()` or test doubles.

## API and WebSocket Communication
- Backend uses FastAPI with HTTP endpoints at `/api/v1/*` and WebSocket at `/ws`. WebSocket sends JSON messages with `type` field for message discrimination.
- Frontend uses `ScannerAPIClient` class for HTTP calls and WebSocket hooks for real-time updates. All API errors throw `APIError` with status code and message.
- WebSocket message types defined in `src/types.ts`: `StateUpdateMessage`, `EventMessage`, `ProgressMessage`, `ErrorMessage`, `PingMessage`.
- Use proper error boundaries for async operations; handle connection failures gracefully with UI feedback.

## Commit & Pull Request Guidelines
- Use imperative mood in commit messages: "Implement X feature", "Fix Y bug", "Add Z endpoint", "Update W module".
- PR titles should summarize the change; PR body should include: short description, linked issue (if any), screenshots for UI changes, testing notes.
- Ensure all tests pass before submitting PR. Run `python -m unittest discover` in backend and `npm run test` in frontend.

## Configuration & Docs
- Copy `backend/config.example.yaml` to `backend/config.yaml` for local settings. Never commit `config.yaml` with production secrets.
- Follow API contract in `docs/API_SPEC.md`; update specs when behavior changes.
- Protocol commands (e.g., PRG, STS, MDL) are scanner-specific; implement in driver classes (`BC125ATDriver`, `SR30CDriver`) inheriting from `ScannerDriver`.

## Environment Setup
- Python: Use virtualenv in `backend/.venv/`. Activate before running any Python commands. Dependencies are installed via `pip install -e .`.
- Frontend: Dependencies in `package.json`. Use `npm install` to install after pulling changes. Run dev server with `npm run dev`.
- Tauri desktop: Run `npm run tauri:dev` from root to test desktop integration. Backend must be running or started via dev script.

## Additional Backend Conventions
- **Module Organization**: Keep `models.py` for Pydantic models and dataclasses, `state.py` for state management, `api.py` for FastAPI endpoints.
- **Driver Pattern**: All scanner drivers inherit from `ScannerDriver` (in `protocol/base.py`). Each scanner model has its own driver module.
- **Scheduler**: Use `CommandScheduler` for serializing commands to the hardware. Respect priority levels: `PRIORITY_TELEMETRY`, `PRIORITY_BACKGROUND`.
- **Transport Layer**: `SerialTransport` and `UsbTransport` handle device communication. Drivers should not directly interact with hardware.
- **State Management**: Use `StateStore` class for managing device state and shadow state (memory channels). Thread-safe updates via `update_live_state()` and `set_shadow_state()`.
- **Exporters**: Export modules (MQTT, JSON stream, text file) live in `exporters/` and subscribe to state changes.
- **Data Sanitization**: Always validate and sanitize data from device before returning to API. Device registers may contain invalid values; use default values when validation fails.
- **Error Handling in API**: Catch specific exceptions (ValueError, HTTPException) and rethrow with meaningful error codes. Use `logger.error()` for unexpected failures.

## Additional Frontend Conventions
- **Component Structure**: Organize components by feature/domain in `src/app/components/`. UI primitives go in `src/app/components/ui/` (shadcn/ui).
- **WebSocket**: Use hooks from `src/websocket/` for real-time state. Handle reconnection gracefully with exponential backoff.
- **Store Patterns**: Zustand stores should be simple and focused. Use selectors (`useStore((s) => s.value)`) to prevent unnecessary re-renders.
- **API Client**: `ScannerAPIClient` in `src/api/client.ts` handles all HTTP requests. Don't use `fetch` directly in components.
- **Notification System**: Use `useNotifications` hook for displaying toast messages. Notifications auto-dismiss but allow manual close.
- **React Patterns**: Use `useRef()` for values persisting across renders without triggering re-renders (tracking latest values in callbacks). Use `useState()` for UI-updating values.

## Performance Considerations
- Backend: Avoid blocking operations in async functions. Use `asyncio.gather()` for concurrent I/O when safe. Cache expensive computations.
- Frontend: Use `React.memo()` for expensive components. Implement virtualization for long lists (e.g., `embla-carousel-react`). Debounce search/filter inputs.

## Security Best Practices
- Never log sensitive data (passwords, tokens, private keys).
- Validate all user input on both client and server sides.
- Use environment variables for secrets; never commit `.env` files.
- Rate-limit API endpoints where appropriate.

## Debugging Tips
- Backend: Use `logger.debug()` extensively for tracing. Enable verbose logging via config.
- Frontend: Use React DevTools for component inspection. Network tab for API calls.
- WebSocket: Use browser console to filter WebSocket messages with `ws:` prefix.

## Code Organization Patterns
- Backend: Place protocol-specific logic in `protocol/` subdirectory. Each scanner driver is its own file with corresponding tests.
- Frontend: Group related components in feature directories (e.g., `components/views/`, `components/ui/`). Shared hooks go in `hooks/`, utilities in `lib/` or `utils/`.
- Types: Define TypeScript interfaces that mirror Pydantic models in `src/types.ts`. Keep them in sync with backend API contracts.

## Error Response Format
- Backend API errors return JSON with `error`, `message`, and `code` fields (see `ErrorResponse` in models.py).
- Frontend `APIError` class wraps these with `status` and `payload` properties for easier handling.
- Always provide user-friendly error messages; log technical details on backend.

## Memory and Persistence
- Backend uses SQLite for persistence (`scanner.db` and `analytics.db`). Never commit database files.
- Memory channels are synced via `MemorySyncTask` in `backend/src/scanner_bridge/sync.py`.
- Frontend stores should persist critical state to localStorage where appropriate.

## WebSocket Message Flow
- Backend sends periodic state updates via `StateUpdateMessage` with sequence numbers.
- `EventMessage` for discrete events: scan hits, mode changes, errors.
- `ProgressMessage` for long-running operations (memory sync, firmware updates).
- `ErrorMessage` for critical failures that need user attention.

## Component Lifecycle
- Frontend components should cleanup WebSocket subscriptions and timers in `useEffect` cleanup functions.
- Backend FastAPI lifespan events handle startup/shutdown (see `main.py` lifespan context manager).

## Testing Patterns
- Backend tests: Use `setUp()` for test initialization. Create fresh instances for each test.
- Frontend tests: Use `render()` from `@testing-library/react`. Test component behavior, not internal state.
- Mocking: Prefer test doubles and stub classes over heavy mocking frameworks.

## Documentation Standards
- Complex functions should have docstrings explaining purpose, parameters, and return values.
- API endpoints should have FastAPI docstrings that appear in OpenAPI spec.
- Frontend components with complex props should document their interfaces.

## Branch Workflow
- Main branch should always be deployable.
- Feature branches named `feature/description` or `fix/description`.
- Keep commits atomic and focused on single changes.

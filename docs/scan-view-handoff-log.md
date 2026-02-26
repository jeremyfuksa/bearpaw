# Scan View Handoff Log

This file tracks findings discovered during scan-view bugfix work that are intentionally out of scope for the current agent.

## Items

### HOFF-001
- ID: `HOFF-001`
- Subsystem: `Legacy Python Backend Preferences Routing`
- File:line/function: `backend/src/bearpaw/api.py` (`get_preference`, duplicate route registration for `GET /api/v1/preferences/{key}`)
- Observed behavior: The same HTTP method/path is registered twice with two different handler functions in the legacy Python backend.
- Why out-of-scope: Current desktop runtime backend is Rust (`crates/bearpaw-api`), so this does not impact active scan-view behavior.
- Suggested owner: `Legacy backend maintenance agent`

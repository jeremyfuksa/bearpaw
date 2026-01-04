# Integration & Shared Todo List

## Phase 1: API Contract Definition

- [ ] **CONTRACT-001** Define REST API specification
  - OpenAPI 3.0 schema document
  - All endpoints with request/response schemas
  - Error response formats
  - Authentication headers (future)

- [ ] **CONTRACT-002** Define WebSocket message schema
  - JSON Schema for each message type
  - Message type discriminator field
  - Versioning strategy
  - Example payloads for each type

- [ ] **CONTRACT-003** Define state data models
  - Live state schema (frequency, mode, RSSI, squelch)
  - Shadow state schema (channels, alpha tags, banks)
  - Device info schema (model, firmware, capabilities)
  - Timestamp and sequence number conventions

- [ ] **CONTRACT-004** Generate TypeScript types from schemas
  - OpenAPI → TypeScript (openapi-typescript)
  - JSON Schema → TypeScript (json-schema-to-typescript)
  - Share types between backend validation and frontend
  - Commit types to version control

## Phase 2: Development Infrastructure

- [ ] **INFRA-001** Create mock backend for frontend development
  - Standalone mock server
  - Implements full API contract
  - Simulates realistic scanner behavior
  - Configurable scenarios (scanning, errors, disconnects)

- [ ] **INFRA-002** Create API integration test suite
  - Tests that run against real backend
  - Validates API contract conformance
  - Covers happy path and error cases
  - Automated in CI/CD pipeline

- [ ] **INFRA-003** Set up development docker-compose
  - Backend service container
  - Frontend dev server container
  - Shared network for API communication
  - Volume mounts for live code reload

- [ ] **INFRA-004** Configure CORS for development
  - Backend allows frontend dev server origin
  - Frontend proxy configuration (optional)
  - Document CORS requirements
  - Production CORS lockdown strategy

## Phase 3: Integration Testing

- [ ] **TEST-001** Create end-to-end test scenarios
  - User flow: connect → scan → hold → tune
  - State synchronization validation
  - Reconnection after backend restart
  - Error recovery scenarios

- [ ] **TEST-002** Test WebSocket message flow
  - Backend sends state update → frontend renders
  - Frontend sends command → backend executes → state updates
  - Message ordering guarantees
  - Late-joiner clients receive current state

- [ ] **TEST-003** Test API error handling
  - 400 Bad Request for invalid inputs
  - 404 Not Found for missing resources
  - 503 Service Unavailable during scanner errors
  - Timeout handling for slow operations

- [ ] **TEST-004** Performance testing
  - WebSocket message throughput (10Hz STS polling)
  - Latency from backend state change to frontend render
  - Memory usage over extended operation
  - Connection handling with multiple clients

## Phase 4: Documentation

- [ ] **DOCS-001** Write architecture overview
  - System diagram (scanner → backend → frontend)
  - Data flow diagrams
  - Deployment topology options
  - Security boundaries

- [ ] **DOCS-002** Create API usage guide
  - Authentication (future)
  - Rate limiting (if applicable)
  - WebSocket connection best practices
  - Example client implementations (Python, JavaScript)

- [ ] **DOCS-003** Write deployment guide
  - Combined deployment (backend serves frontend)
  - Separate deployment (CORS configuration)
  - Reverse proxy setup (nginx, Caddy)
  - SSL/TLS termination

- [ ] **DOCS-004** Create troubleshooting guide
  - Common connection issues
  - WebSocket debugging tips
  - Serial port permission problems
  - Log locations and interpretation

## Phase 5: Release Preparation

- [ ] **RELEASE-001** Define versioning strategy
  - Semantic versioning for backend
  - Frontend version tied to backend API version
  - Compatibility matrix
  - Deprecation policy

- [ ] **RELEASE-002** Create changelog automation
  - Conventional commits
  - Auto-generate changelog from git history
  - Release notes template
  - Migration guides for breaking changes

- [ ] **RELEASE-003** Set up CI/CD pipeline
  - Backend: lint, test, build, package
  - Frontend: lint, test, build
  - Integration: e2e tests
  - Artifact publishing

- [ ] **RELEASE-004** Create distribution packages
  - Backend binaries for macOS, Windows, Linux
  - Frontend static bundle
  - Combined package (backend + frontend)
  - Installer/upgrade scripts

## Phase 6: Quality Assurance

- [ ] **QA-001** Cross-platform testing matrix
  - macOS: arm64 and x86_64
  - Windows: 10, 11
  - Linux: Ubuntu, Fedora, Arch
  - Document platform-specific issues

- [ ] **QA-002** Browser compatibility testing
  - Chrome/Edge (Chromium)
  - Firefox
  - Safari (macOS, iOS)
  - Mobile browsers (iOS Safari, Chrome Android)

- [ ] **QA-003** Hardware compatibility testing
  - BC125AT real hardware validation
  - SR30C real hardware validation (when available)
  - USB hub compatibility
  - Long-running stability test (24+ hours)

- [ ] **QA-004** Multi-client testing
  - Multiple browser tabs connected simultaneously
  - Mixed read-only and control clients
  - Concurrent command issuing
  - State consistency across all clients

## Phase 7: Security

- [ ] **SECURITY-001** API security hardening
  - Input validation on all endpoints
  - Prevent command injection via KEY command
  - Rate limiting for control commands
  - Authentication requirement (future)

- [ ] **SECURITY-002** WebSocket security
  - Origin validation
  - Authentication token in connection (future)
  - Message size limits
  - Connection limits per IP

- [ ] **SECURITY-003** Frontend security
  - Content Security Policy (CSP)
  - No eval() or inline scripts
  - Sanitize user input
  - HTTPS enforcement (production)

- [ ] **SECURITY-004** Security audit
  - Dependency vulnerability scanning
  - OWASP top 10 review
  - Penetration testing (if publicly exposed)
  - Security disclosure policy

## Phase 8: Monitoring & Observability

- [ ] **OBS-001** Add structured logging
  - Backend: log levels (DEBUG, INFO, WARN, ERROR)
  - Request/response logging (with PII redaction)
  - Performance metrics (command latency, poll rate)
  - Log output to file and/or stdout

- [ ] **OBS-002** Add metrics collection
  - Prometheus-compatible metrics endpoint
  - Request counters by endpoint
  - WebSocket connection gauge
  - Serial error rate

- [ ] **OBS-003** Health check endpoints
  - GET /health/live (process alive)
  - GET /health/ready (scanner connected and responsive)
  - Include version and uptime
  - Frontend health check (API reachable)

- [ ] **OBS-004** Error tracking integration
  - Sentry or similar (optional)
  - Frontend error boundary reporting
  - Backend exception reporting
  - User consent and privacy policy

## Phase 9: User Onboarding

- [ ] **ONBOARD-001** First-run experience
  - Device detection and connection flow
  - Permission requests (serial port access)
  - Quick start tutorial overlay
  - Sample activity log entries

- [ ] **ONBOARD-002** Configuration wizard
  - Scanner model selection (if not auto-detected)
  - WebSocket connection settings
  - Audio input selection (future)
  - Save and validate configuration

- [ ] **ONBOARD-003** Help system
  - In-app help tooltips
  - Context-sensitive help panel
  - Link to online documentation
  - Report issue button (GitHub issues)

## Phase 10: Future Integration Work

- [ ] **FUTURE-001** Desktop notification integration
  - Backend triggers frontend notifications
  - System notifications for scan hits
  - Configurable notification rules
  - Platform-specific APIs (macOS, Windows, Linux)

- [ ] **FUTURE-002** Home automation integration
  - MQTT exporter in backend
  - Home Assistant integration
  - Node-RED flow examples
  - Webhook support for scan hits

- [ ] **FUTURE-003** Mobile app
  - React Native or Flutter app
  - Reuse WebSocket/REST client code
  - Native notifications
  - Background operation support

- [ ] **FUTURE-004** Multi-user support
  - User authentication and sessions
  - Role-based access control (admin, viewer)
  - User preferences stored server-side
  - Audit log for control actions

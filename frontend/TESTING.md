# Frontend Testing Guide

## Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

## Test Structure

```
frontend/src/
├── test/
│   ├── setup.ts                 # Test setup (jest-dom import)
│   ├── utils/
│   │   ├── index.ts           # Utility exports
│   │   ├── testProviders.tsx  # renderWithProviders
│   │   ├── apiMock.ts         # Mock fetch helpers
│   │   └── webSocketMock.ts   # WebSocket mock
│   ├── mocks/
│   │   ├── index.ts           # Mock exports
│   │   ├── mockStore.ts       # Zustand store mock
│   │   ├── mockApiClient.ts   # API client mock
│   │   └── webSocketMock.ts  # WebSocket mock
│   └── fixtures/
│       ├── index.ts           # Fixture exports
│       ├── data.ts            # Test data factories
│       └── apiResponses.ts    # Mock API responses
└── **/__tests__/**/*.test.tsx     # Test files
```

## Writing Tests

### Component Tests

```typescript
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

describe("ComponentName", () => {
  it("should render correctly", () => {
    render(<Component {...props} />);
    expect(screen.getByText("expected text")).toBeInTheDocument();
  });

  it("should handle user interactions", async () => {
    const onAction = vi.fn();
    render(<Component onAction={onAction} />);
    
    await userEvent.click(screen.getByRole("button"));
    expect(onAction).toHaveBeenCalled();
  });

  it("should display error state", () => {
    render(<Component error="Error message" />);
    expect(screen.getByText("Error message")).toBeInTheDocument();
  });
});
```

### API Client Tests

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ScannerAPIClient } from "@/api/client";
import { mockFetch, resetMockFetch } from "@/test/utils";
import { mockApiResponses } from "@/test/fixtures";

describe("ScannerAPIClient", () => {
  let client: ScannerAPIClient;

  beforeEach(() => {
    client = new ScannerAPIClient("/api/v1");
  });

  afterEach(() => {
    resetMockFetch();
  });

  it("should fetch status successfully", async () => {
    mockFetch(mockApiResponses.status);
    const status = await client.getStatus();
    expect(status).toEqual(mockApiResponses.status);
  });

  it("should handle errors correctly", async () => {
    mockFetchError(503, "Device not connected");
    await expect(client.getStatus()).rejects.toThrow("Device not connected");
  });
});
```

## Testing Patterns

### 1. Mocking API Responses

```typescript
import { mockFetch } from "@/test/utils";
import { mockApiResponses } from "@/test/fixtures";

mockFetch(mockApiResponses);
```

### 2. Mocking API Errors

```typescript
import { mockFetchError } from "@/test/utils";

mockFetchError(503, "Device not connected");
```

### 3. Using Test Data Fixtures

```typescript
import { createTestChannel, createTestLiveState } from "@/test/fixtures";

const testChannel = createTestChannel({ index: 1, frequency: 151.25 });
const testState = createTestLiveState({ mode: "SCAN" });
```

### 4. Mocking Zustand Store

```typescript
import { createMockStore } from "@/test/mocks";

const mockStore = createMockStore({
  liveState: createTestLiveState(),
  connected: true,
});

render(<Component store={mockStore} />);
```

### 5. Accessible Queries

Use accessible queries over test-specific queries:

```typescript
screen.getByRole("button")           // Good
screen.getByRole("button", { name: "Submit" })  // Better
screen.getByLabelText("Volume")      // Best
```

### 6. User Interactions

```typescript
import userEvent from "@testing-library/user-event";

await userEvent.click(button);
await userEvent.type(input, "text");
await userEvent.select(select, "option");
await userEvent.click(screen.getByRole("option", { name: "option" }));
```

## Best Practices

1. **Test behavior, not implementation**
   - Test what the component does, not how it does it
   - Test from user's perspective

2. **Use descriptive test names**
   - `should display error when API fails` (good)
   - `render` (bad)

3. **Keep tests independent**
   - Each test should be able to run alone
   - Use `beforeEach`/`afterEach` for setup/cleanup

4. **Mock external dependencies**
   - Mock API, WebSocket, store
   - Use test fixtures for consistent data

5. **Use appropriate assertions**
   - `expect(x).toBe(y)` for primitives
   - `expect(x).toEqual(y)` for objects
   - `expect(screen.getBy...).toBeInTheDocument()` for DOM

## Coverage Goals

- **Components**: 80% coverage
- **API Client**: 90% coverage  
- **Store**: 85% coverage
- **Hooks**: 85% coverage
- **Overall**: 75% coverage

## Debugging Tests

```bash
# Run tests in watch mode
npm run test:watch

# Run specific test file
npm run test -- path/to/test.test.tsx

# Run tests matching pattern
npm run test -- --run test --grep "should display"
```

## Common Issues

### ResizeObserver not defined

If you see `ResizeObserver is not defined` in tests, the component uses Radix UI components that need a polyfill. This is a known issue with jsdom and certain UI components.

**Workaround**: Focus on testing the component's behavior and state changes rather than full rendering with all sub-components.

### SVG elements

SVG elements don't always have `role="img"`. Use `container.querySelector("svg")` instead.

### Async Components

For async components, use `waitFor` or use mock timers:

```typescript
await waitFor(() => expect(screen.getByText("loaded")).toBeInTheDocument());
```

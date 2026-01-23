import { ReactElement } from "react";
import { render, RenderOptions } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import type { AppStore } from "../../store/useStore";

export interface TestProvidersProps {
  children: React.ReactNode;
  mockStore?: Partial<AppStore>;
  mockApi?: Record<string, unknown>;
}

const MockProviders = ({ children, mockStore, mockApi }: TestProvidersProps) => {
  return <>{children}</>;
};

export const renderWithProviders = (
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper"> & {
    mockStore?: Partial<AppStore>;
    mockApi?: Record<string, unknown>;
  }
) => {
  const { mockStore, mockApi, ...renderOptions } = options ?? {};

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <MockProviders mockStore={mockStore} mockApi={mockApi}>
      {children}
    </MockProviders>
  );

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
  };
};

export const renderHookWithProviders = <T,>(
  hook: () => T,
  options?: {
    mockStore?: Partial<AppStore>;
    mockApi?: Record<string, unknown>;
  }
) => {
  const { mockStore, mockApi } = options ?? {};

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MockProviders mockStore={mockStore} mockApi={mockApi}>
      {children}
    </MockProviders>
  );

  return renderHook(hook, { wrapper });
};

export const waitForStateUpdate = async (
  selector: (state: AppStore) => unknown,
  timeout: number = 1000
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const checkState = () => {
      if (Date.now() - startTime > timeout) {
        reject(new Error(`State update timeout after ${timeout}ms`));
        return;
      }
      resolve();
    };
    checkState();
  });
};

import { vi } from "vitest";

export const mockApiResponse = <T>(
  data: T,
  delay: number = 0,
  error: { status: number; message: string } | null = null
): Promise<T> => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (error) {
        reject(new Error(`API Error ${error.status}: ${error.message}`));
      } else {
        resolve(data);
      }
    }, delay);
  });
};

export const mockFetch = (response: unknown, status: number = 200): void => {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(typeof response === "string" ? response : JSON.stringify(response)),
    } as Response)
  );
};

export const mockFetchError = (status: number, message: string): void => {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ error: message, message }),
      text: () => Promise.resolve(message),
    } as Response)
  );
};

export const mockFetchNetworkError = (): void => {
  global.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
};

export const resetMockFetch = (): void => {
  vi.restoreAllMocks();
};

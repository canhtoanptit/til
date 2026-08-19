import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { render, type RenderResult } from "@testing-library/react";

/**
 * The two providers every client surface assumes are above it: a react-query
 * client and a router. Rendering a page without either throws, which is why this
 * lives in one place instead of in each test file.
 *
 * Retries are off. With them on, a test that asserts an error state waits for
 * three exponentially-backed-off attempts before the state it wants appears, and
 * a test that asserts "the API was called once" sees three calls.
 */
export interface RenderedWithProviders extends RenderResult {
  /** The router's current pathname — how a navigation assertion reads it. */
  currentPath: () => string;
  queryClient: QueryClient;
}

export function renderWithProviders(
  ui: ReactNode,
  options: { route?: string } = {},
): RenderedWithProviders {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? "/"]}>
        {ui}
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return {
    ...result,
    queryClient,
    currentPath: () =>
      result.container.querySelector("[data-location-probe]")?.textContent ??
      "",
  };
}

/**
 * Reads the router's location into the DOM so a test can assert on where a
 * `navigate()` or `<Link>` actually went, rather than on a mocked `useNavigate`
 * spy that would pass even if the route did not exist.
 */
function LocationProbe() {
  const location = useLocation();
  return (
    <span data-location-probe="" hidden>
      {location.pathname + location.search}
    </span>
  );
}

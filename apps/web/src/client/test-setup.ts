import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library's auto-cleanup only registers itself when a global `afterEach`
// exists, and this repo runs vitest without globals. So unmount explicitly —
// without it, every test in a file renders into the previous test's DOM and
// `getByRole` starts finding two of everything.
afterEach(() => {
  cleanup();
});

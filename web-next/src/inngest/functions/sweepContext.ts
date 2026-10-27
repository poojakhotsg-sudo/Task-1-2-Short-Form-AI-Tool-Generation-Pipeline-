// Minimal shape each sweep handler actually uses from Inngest's function
// context. Declared explicitly (rather than inferred inline) so each
// handler can be exported as a named function and called directly in
// tests with a lightweight fake, without needing Inngest's runtime at
// all — the same pattern Inngest's own testing docs recommend.
export interface SweepContext {
  step: {
    run: <T>(id: string, fn: () => Promise<T> | T) => Promise<T>;
  };
  logger: {
    info: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

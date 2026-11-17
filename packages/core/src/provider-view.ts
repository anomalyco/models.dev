export function includedProviders(params: URLSearchParams) {
  return new Set(
    params.getAll("include")
      .flatMap((value) => value.split(","))
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

// Only this recently added provider is opt-in. Existing providers stay public.
export function providerView<T extends Record<string, unknown>>(
  providers: T,
  expanded: boolean,
): T {
  if (expanded) return providers;
  return Object.fromEntries(
    Object.entries(providers).filter(([id]) => id !== "openai-codex"),
  ) as T;
}

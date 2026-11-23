export function includedProviders(params: URLSearchParams) {
  return new Set(
    params.getAll("include")
      .flatMap((value) => value.split(","))
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

// These providers need client-managed ChatGPT sign-in, so they are left out unless a request names them.
// Existing providers stay public.
export const OPT_IN_PROVIDERS = ["openai-chatgpt", "openai-codex"];

// The opt-in providers a request names, in OPT_IN_PROVIDERS order.
export function includedOptIn(params: URLSearchParams) {
  const included = includedProviders(params);
  return OPT_IN_PROVIDERS.filter((id) => included.has(id));
}

// Every set of opt-in providers a request can name, each in OPT_IN_PROVIDERS order.
export function optInSets() {
  return OPT_IN_PROVIDERS.reduce<string[][]>(
    (sets, id) => [...sets, ...sets.map((set) => [...set, id])],
    [[]],
  );
}

// The prebuilt v2 file suffix for a set of opt-in providers.
export function optInSuffix(included: readonly string[]) {
  return included.length === 0 ? "" : `-include-${included.join("-")}`;
}

export function providerView<T extends Record<string, unknown>>(
  providers: T,
  included: readonly string[],
): T {
  const hidden = OPT_IN_PROVIDERS.filter((id) => !included.includes(id));
  if (hidden.length === 0) return providers;
  return Object.fromEntries(
    Object.entries(providers).filter(([id]) => !hidden.includes(id)),
  ) as T;
}

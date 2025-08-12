// Lightweight import-map resolver for createGraph.resolve

export type ImportMapJson = {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
};

function isLikeUrl(specifier: string): boolean {
  try {
    new URL(specifier);
    return true;
  } catch {
    return false;
  }
}

function resolveAgainst(base: URL, target: string): string {
  try {
    return new URL(target, base).href;
  } catch {
    return target;
  }
}

function applyMappings(
  mappings: Record<string, string> | undefined,
  specifier: string,
  baseUrl: URL,
): string | undefined {
  if (!mappings) return undefined;

  if (Object.prototype.hasOwnProperty.call(mappings, specifier)) {
    const target = mappings[specifier]!;
    return isLikeUrl(target) ? target : resolveAgainst(baseUrl, target);
  }

  let bestKey: string | undefined;
  for (const key of Object.keys(mappings)) {
    if (!key.endsWith('/')) continue;
    if (specifier.startsWith(key)) {
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
  }
  if (bestKey) {
    const mapped = mappings[bestKey]!;
    const suffix = specifier.slice(bestKey.length);
    const target = mapped + suffix;
    return isLikeUrl(target) ? target : resolveAgainst(baseUrl, target);
  }

  return undefined;
}

export function createImportMapResolver(
  baseUrl: URL,
  imports?: Record<string, string>,
  scopes?: Record<string, Record<string, string>>,
): (specifier: string, referrer?: string) => string {
  const scopesEntries = Object.entries(scopes ?? {});

  return (specifier: string, referrer?: string): string => {
    if (isLikeUrl(specifier) || specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      try {
        const baseForRel = referrer ? new URL(referrer) : baseUrl;
        return new URL(specifier, baseForRel).href;
      } catch {
        return specifier;
      }
    }

    let scopedResolved: string | undefined;
    if (referrer) {
      let bestScope: string | undefined;
      for (const [scopePrefix] of scopesEntries) {
        try {
          const refUrl = new URL(referrer);
          if (refUrl.href.startsWith(scopePrefix)) {
            if (!bestScope || scopePrefix.length > bestScope.length) bestScope = scopePrefix;
          }
        } catch {}
      }
      if (bestScope) {
        scopedResolved = applyMappings((scopes ?? {})[bestScope!], specifier, baseUrl);
      }
    }
    if (scopedResolved) return scopedResolved;

    const topResolved = applyMappings(imports, specifier, baseUrl);
    if (topResolved) return topResolved;

    return specifier;
  };
}
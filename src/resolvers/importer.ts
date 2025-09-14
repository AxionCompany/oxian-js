const inMemoryCache = new Map<string, Record<string, unknown>>();

function sanitizeUrlForLog(input: string): string {
    try {
        const u = new URL(input);
        if (u.username || u.password) {
            u.username = "***";
            u.password = "***";
        }
        return u.toString();
    } catch {
        return input;
    }
}

const getExtension = (str: string) => {
    const stripSearch = str.split('?')[0];
    const extension = stripSearch.split('.').pop();
    return extension;
}

const mapExtensionToWith = (extension: string) => {
    switch (extension) {
        case "json": return "json"
        case "ts": return;
        case "tsx": return;
        case "jsx": return;
        case "js": return;
        case "mjs": return;
        case "cjs": return;
    }
    return "text";
}


export async function importModule(url: URL | string, _ttlMs = 60_000): Promise<Record<string, unknown>> {

    // debug: importModule call context (guarded by OXIAN_DEBUG)
    if (Deno.env.get("OXIAN_DEBUG") === "1") {
        try { console.log('importModule', sanitizeUrlForLog((url as URL).toString()), { ttl: _ttlMs, }); } catch { console.log('importModule', sanitizeUrlForLog(String(url)), { ttl: _ttlMs, }); }
    }

    // In-memory cache for faster file loads
    if (inMemoryCache.has(url?.toString())) {
        return inMemoryCache.get(url?.toString()) as Record<string, unknown>;
    }

    try {
        // Resolve specifier to a fetchable URL (file: or https:)
        let mod: Record<string, unknown>;

        const extension = getExtension(url?.toString());
        const importType = mapExtensionToWith(extension?.toString());

        if ((!url?.toString().startsWith("file:"))) {
            const importDataUrl = `data:text/typescript;base64,${btoa(importModuleTemplate(url.toString(), importType))}`;
            try {
                mod = await import(importDataUrl);
            } catch { /* ignore */ }
        } else {
            const finalSpecifier = url?.toString();
            if (importType) {
                mod = await import(finalSpecifier, { with: { type: importType } });
            } else {
                mod = await import(finalSpecifier);
            }
        }

        inMemoryCache.set(url?.toString(), mod as Record<string, unknown>);

        return mod as Record<string, unknown>;
    } catch (e) {
        // module not found, set cache to empty object
        try {
            inMemoryCache.set(url?.toString(), {});
        } catch {
            // ignore cache set failure
        }
        throw e;
    }
}

const importModuleTemplate = (specifier: string, importType: "json" | "text" | "bytes" | undefined) => `
import * as mod from "${specifier}"${importType ? ` with { type: "${importType}" }` : ""};
export default mod?.default;
export * from "${specifier}"${importType ? ` with { type: "${importType}" }` : ""};
`

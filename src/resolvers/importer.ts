
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
    const extensionArray = stripSearch.split('.')
    if(extensionArray.length === 1) return;
    const extension = extensionArray.pop();
    return extension;
}

const mapExtensionToWith = (extension?: string): "json" | "text" | "bytes" | undefined => {
    switch (extension) {
        case "json": return "json"
        case undefined: return;
        case "": return;
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

    const urlStr = (url instanceof URL) ? url.toString() : String(url);

    try {
        // Resolve specifier to a fetchable URL (file: or https:)
        let mod: Record<string, unknown> | undefined;

        const extension = getExtension(urlStr);
        const importType = mapExtensionToWith(extension);

        if ((!urlStr.startsWith("file:"))) {
            const importDataUrl = `data:text/typescript;base64,${btoa(importModuleTemplate(urlStr, importType))}`;
            if (importType) {
                mod = await import(importDataUrl, { with: { type: importType } });
            } else {
                mod = await import(importDataUrl);
            }
        } else {
            const finalSpecifier = urlStr;
            if (importType) {
                mod = await import(finalSpecifier, { with: { type: importType } });
            } else {
                mod = await import(finalSpecifier);
            }
        }

        return mod as Record<string, unknown>;
    } catch (e) {
        throw e;
    }
}

const importModuleTemplate = (specifier: string, importType: "json" | "text" | "bytes" | undefined) => `
import * as mod from "${specifier}"${importType ? ` with { type: "${importType}" }` : ""};
export default mod?.default;
export * from "${specifier}"${importType ? ` with { type: "${importType}" }` : ""};
`

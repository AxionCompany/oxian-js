import type { Loader } from "./types.ts";
import { detectMediaType } from "./types.ts";

export function createHttpLoader(): Loader {
    return {
        scheme: "http",
        canHandle: (url: URL) => {
            return url.protocol === "http:" || url.protocol === "https:";
        },
        async load(url: URL) {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP load failed ${res.status} for ${url}`);
            const contentType = res.headers.get("content-type") ?? "";
            const content = await res.text();
            let mediaType = detectMediaType(url.pathname);
            if (contentType.includes("application/json")) mediaType = "json";
            return { content, mediaType };
        },
    } as Loader;
} 
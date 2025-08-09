import type { Loader } from "../loader/types.ts";
import { bundleModule } from "./bundler.ts";

export async function importModule(url: URL, loaders: Loader[], ttlMs = 60_000): Promise<Record<string, unknown>> {
    const code = await bundleModule(url, loaders, ttlMs);
    const dataUrl = `data:application/javascript,${encodeURIComponent(code)}`;
    return await import(dataUrl);
} 
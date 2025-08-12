import type { Loader } from "../loader/types.ts";
import { bundleModule } from "./bundler.ts";

export async function importModule(url: URL, loaders: Loader[], ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    const code = await bundleModule(url, loaders, ttlMs, projectRoot);
    const dataUrl = `data:application/typescript;base64,${btoa(encodeURIComponent(code))}`;
    return await import(dataUrl);
} 
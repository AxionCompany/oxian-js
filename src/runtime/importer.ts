import type { Loader } from "../loader/types.ts";
import { bundleModule } from "./bundler.ts";
import { encodeBase64 } from "jsr:@std/encoding@1.0.5/base64";

export async function importModule(url: URL, loaders: Loader[], ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    const code = await bundleModule(url, loaders, ttlMs, projectRoot);
    const dataUrl = `data:application/typescript;base64,${encodeBase64(new TextEncoder().encode(code))}`;
    return await import(dataUrl);
} 
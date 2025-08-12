import type { Loader } from "../loader/types.ts";
import { bundleModule } from "./bundler.ts";
import { encodeBase64 } from "@std/encoding/base64";

export async function importModule(url: URL, loaders: Loader[], ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    const code = await bundleModule(url, loaders, ttlMs, projectRoot);
    const codeWithSourceUrl = `${code}\n//# sourceURL=${url.toString()}`;
    const dataUrl = `data:application/typescript;base64,${encodeBase64(new TextEncoder().encode(codeWithSourceUrl))}`;
    return await import(dataUrl);
} 
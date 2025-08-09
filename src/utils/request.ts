import { Data } from "../core/types.ts";

export async function parseRequestBody(req: Request): Promise<unknown> {
    const ct = req.headers.get("content-type") ?? "";
    try {
        if (ct.includes("application/json")) {
            const text = await req.text();
            if (!text) return undefined;
            return JSON.parse(text);
        }
        if (ct.includes("text/plain")) {
            return await req.text();
        }
        if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
            const formData = await req.formData();
            const data: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(formData)) {
                data[k] = v;
            }
            return data;
        }
    } catch {
        return undefined;
    }
    return undefined;
}

export function parseQuery(url: URL): { params: URLSearchParams; record: Record<string, string | string[]> } {
    const params = url.searchParams;
    const record: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(params)) {
        const existing = record[k];
        if (existing === undefined) record[k] = v;
        else if (Array.isArray(existing)) existing.push(v);
        else record[k] = [existing, v];
    }
    return { params, record };
}

export function mergeData(pathParams: Record<string, string>, query: Record<string, string | string[]>, body: unknown): Data {
    const data: Record<string, unknown> = {};
    // body
    if (body && typeof body === "object") Object.assign(data, body as Record<string, unknown>);
    // query overrides body
    for (const [k, v] of Object.entries(query)) data[k] = v;
    // path params override query
    for (const [k, v] of Object.entries(pathParams)) data[k] = v;
    return data;
} 
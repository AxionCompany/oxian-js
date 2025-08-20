import type { Context, Data } from "oxian-js/types.ts";
import fs from "node:fs";

export async function GET(data: Data, context: Context) {

    const dir = fs.readdirSync('.')

    return { hello: "world", dir };
} 
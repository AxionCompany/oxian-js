import type { Context, Data } from "oxian-js/types.ts";
import fs from "node:fs";

export async function GET(data: Data, context: Context) {

    const dir = fs.readdirSync('.')

    const env = Deno.env.toObject()

    return { hello: "world", dir, env };
} 
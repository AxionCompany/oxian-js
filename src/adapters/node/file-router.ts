import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Internal filesystem boundary, also supported by Deno's Node compatibility. */
export function resolveRouterPath(path: string): URL {
  return pathToFileURL(resolve(path));
}

export async function readRouterDirectory(directory: URL): Promise<
  {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
    isSymlink: boolean;
  }[]
> {
  return (await readdir(directory, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymlink: entry.isSymbolicLink(),
  }));
}

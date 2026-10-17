/** Internal path boundary, also supported by Deno's Node compatibility. */
export { dirname, isAbsolute, normalize, resolve } from "node:path";
export {
  fileURLToPath as fromFileUrl,
  pathToFileURL as toFileUrl,
} from "node:url";

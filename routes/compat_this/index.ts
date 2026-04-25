// deno-lint-ignore-file no-explicit-any
export function GET(this: any, d: any, { response }: any) {
  return (this && this.val) || "none";
}

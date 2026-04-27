// deno-lint-ignore no-explicit-any
export function GET(this: any, d: any, {response}: {response: any}){ return (this && this.val) || 'none'; }

// write temp file to import module
const writeTempFile = (specifier: string, importType: "json" | "text" | "bytes" | undefined) => {
    const tempFile = Deno.makeTempFileSync();
    Deno.writeTextFileSync(tempFile, `import * as mod from "${specifier}"${importType ? ` with { type: "${importType}" }` : ""};
export default mod?.default;
export * from "${specifier}"${importType ? ` with { type: "${importType}" }` : ""};
`);
    return tempFile;
}

console.log(writeTempFile("test.ts", "text"));
function mapHeaderToProject(h) {
    if (!h) return "default";
    if (h === "alpha") return "alpha";
    if (h === "beta") return "beta";
    return "default";
}
async function pickProject(req) {
    const proj = mapHeaderToProject(req.headers.get("x-mcp-project"));
    const prefix = req.headers.get("x-mcp-prefix") ?? undefined;
    return prefix ? {
        project: proj,
        stripPathPrefix: prefix
    } : {
        project: proj
    };
}
async function getProjectConfig(name) {
    return {
        name,
        worker: {
            kind: "process"
        }
    };
}
export { pickProject as pickProject };
export { getProjectConfig as getProjectConfig };

//# sourceURL=http://localhost:18675/provider.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHA6Ly9sb2NhbGhvc3Q6MTg2NzUvaGVscGVyLnRzIiwiaHR0cDovL2xvY2FsaG9zdDoxODY3NS9wcm92aWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDTyxTQUFTLG1CQUFtQixDQUFnQjtJQUNqRCxJQUFJLENBQUMsR0FBRyxPQUFPO0lBQ2YsSUFBSSxNQUFNLFNBQVMsT0FBTztJQUMxQixJQUFJLE1BQU0sUUFBUSxPQUFPO0lBQ3pCLE9BQU87QUFDVDtBQ0hPLGVBQWUsWUFBWSxHQUFZO0lBQzVDLE1BQU0sT0FBTyxtQkFBbUIsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDO0lBQ2hELE1BQU0sU0FBUyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO0lBQ2xELE9BQU8sU0FBUztRQUFFLFNBQVM7UUFBTSxpQkFBaUI7SUFBTyxJQUFJO1FBQUUsU0FBUztJQUFLO0FBQy9FO0FBRU8sZUFBZSxpQkFBaUIsSUFBWTtJQUVqRCxPQUFPO1FBQUU7UUFBTSxRQUFRO1lBQUUsTUFBTTtRQUFVO0lBQUU7QUFDN0M7QUFUQSxTQUFzQixlQUFBLGNBSXJCO0FBRUQsU0FBc0Isb0JBQUEsbUJBR3JCIn0=
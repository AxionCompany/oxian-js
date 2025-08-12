async function beforeRun(_data, { oxian }) {
    oxian.startedAt = performance.now();
}
async function afterRun(resultOrErr, { requestId, oxian }) {
    const hasStatusCode = typeof resultOrErr === "object" && resultOrErr !== null && "statusCode" in resultOrErr;
    const ok = !(resultOrErr instanceof Error) && !hasStatusCode;
    console.log(JSON.stringify({
        requestId,
        ok,
        ms: Math.round(performance.now() - oxian.startedAt)
    }));
}
export { beforeRun as beforeRun };
export { afterRun as afterRun };

//# sourceURL=file:///Users/vfssantos/Documents/Projetos/COPILOTZ/app/oxian-js/routes/interceptors.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vVXNlcnMvdmZzc2FudG9zL0RvY3VtZW50cy9Qcm9qZXRvcy9DT1BJTE9UWi9hcHAvb3hpYW4tanMvcm91dGVzL2ludGVyY2VwdG9ycy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFTyxlQUFlLFVBQVUsS0FBVyxFQUFFLEVBQUUsS0FBSyxFQUFXO0lBQzdELE1BQU0sU0FBUyxHQUFHLFlBQVksR0FBRztBQUNuQztBQUVPLGVBQWUsU0FBUyxXQUFvQixFQUFFLEVBQUUsU0FBUyxFQUFFLEtBQUssRUFBVztJQUNoRixNQUFNLGdCQUFnQixPQUFPLGdCQUFnQixZQUFZLGdCQUFnQixRQUFRLGdCQUFpQjtJQUNsRyxNQUFNLEtBQUssQ0FBQyxDQUFDLHVCQUF1QixLQUFLLEtBQUssQ0FBQztJQUMvQyxRQUFRLEdBQUcsQ0FBQyxLQUFLLFNBQVMsQ0FBQztRQUFFO1FBQVc7UUFBSSxJQUFJLEtBQUssS0FBSyxDQUFDLFlBQVksR0FBRyxLQUFLLE1BQU0sU0FBUztJQUFFO0FBQ2xHO0FBUkEsU0FBc0IsYUFBQSxZQUVyQjtBQUVELFNBQXNCLFlBQUEsV0FJckIifQ==
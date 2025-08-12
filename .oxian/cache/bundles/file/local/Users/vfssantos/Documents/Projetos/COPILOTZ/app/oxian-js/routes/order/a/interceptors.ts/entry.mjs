async function beforeRun(data, _context) {
    const before = Array.isArray(data.before) ? data.before : [];
    before.push("a");
    return {
        data: {
            ...data,
            before
        }
    };
}
async function afterRun(_resultOrErr, { response }) {
    response.headers({
        "x-after": "root,a"
    });
}
export { beforeRun as beforeRun };
export { afterRun as afterRun };

//# sourceURL=file:///Users/vfssantos/Documents/Projetos/COPILOTZ/app/oxian-js/routes/order/a/interceptors.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vVXNlcnMvdmZzc2FudG9zL0RvY3VtZW50cy9Qcm9qZXRvcy9DT1BJTE9UWi9hcHAvb3hpYW4tanMvcm91dGVzL29yZGVyL2EvaW50ZXJjZXB0b3JzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUVPLGVBQWUsVUFBVSxJQUFVLEVBQUUsUUFBaUI7SUFDM0QsTUFBTSxTQUFTLE1BQU0sT0FBTyxDQUFDLEtBQUssTUFBTSxJQUFJLEtBQUssTUFBTSxHQUFHLEVBQUU7SUFDNUQsT0FBTyxJQUFJLENBQUM7SUFDWixPQUFPO1FBQUUsTUFBTTtZQUFFLEdBQUcsSUFBSTtZQUFFO1FBQU87SUFBRTtBQUNyQztBQUVPLGVBQWUsU0FBUyxZQUFxQixFQUFFLEVBQUUsUUFBUSxFQUFXO0lBQ3pFLFNBQVMsT0FBTyxDQUFDO1FBQUUsV0FBVztJQUFTO0FBQ3pDO0FBUkEsU0FBc0IsYUFBQSxZQUlyQjtBQUVELFNBQXNCLFlBQUEsV0FFckIifQ==
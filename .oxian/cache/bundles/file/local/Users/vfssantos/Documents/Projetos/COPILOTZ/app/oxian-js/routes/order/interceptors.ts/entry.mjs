async function beforeRun(data, _context) {
    const before = Array.isArray(data.before) ? data.before : [];
    before.push("root");
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

//# sourceURL=file:///Users/vfssantos/Documents/Projetos/COPILOTZ/app/oxian-js/routes/order/interceptors.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vVXNlcnMvdmZzc2FudG9zL0RvY3VtZW50cy9Qcm9qZXRvcy9DT1BJTE9UWi9hcHAvb3hpYW4tanMvcm91dGVzL29yZGVyL2ludGVyY2VwdG9ycy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFTyxlQUFlLFVBQVUsSUFBVSxFQUFFLFFBQWlCO0lBQzNELE1BQU0sU0FBUyxNQUFNLE9BQU8sQ0FBQyxLQUFLLE1BQU0sSUFBSSxLQUFLLE1BQU0sR0FBRyxFQUFFO0lBQzVELE9BQU8sSUFBSSxDQUFDO0lBQ1osT0FBTztRQUFFLE1BQU07WUFBRSxHQUFHLElBQUk7WUFBRTtRQUFPO0lBQUU7QUFDckM7QUFFTyxlQUFlLFNBQVMsWUFBcUIsRUFBRSxFQUFFLFFBQVEsRUFBVztJQUN6RSxTQUFTLE9BQU8sQ0FBQztRQUFFLFdBQVc7SUFBUztBQUN6QztBQVJBLFNBQXNCLGFBQUEsWUFJckI7QUFFRCxTQUFzQixZQUFBLFdBRXJCIn0=
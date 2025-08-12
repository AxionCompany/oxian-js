function __default(data, context) {
    const auth = context.request.headers.get("authorization");
    if (!auth) throw {
        message: "Unauthorized",
        statusCode: 401,
        statusText: "Unauthorized"
    };
    return {
        data: {
            ...data,
            scope: "users"
        }
    };
}
export { __default as default };

//# sourceURL=file:///Users/vfssantos/Documents/Projetos/COPILOTZ/app/oxian-js/routes/users/middleware.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vVXNlcnMvdmZzc2FudG9zL0RvY3VtZW50cy9Qcm9qZXRvcy9DT1BJTE9UWi9hcHAvb3hpYW4tanMvcm91dGVzL3VzZXJzL21pZGRsZXdhcmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBRWUsbUJBQVUsSUFBVSxFQUFFLE9BQWdCO0lBQ25ELE1BQU0sT0FBTyxRQUFRLE9BQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO0lBQ3pDLElBQUksQ0FBQyxNQUFNLE1BQU07UUFBRSxTQUFTO1FBQWdCLFlBQVk7UUFBSyxZQUFZO0lBQWU7SUFDeEYsT0FBTztRQUFFLE1BQU07WUFBRSxHQUFHLElBQUk7WUFBRSxPQUFPO1FBQVE7SUFBRTtBQUM3QztBQUpBLGdDQUlDIn0=
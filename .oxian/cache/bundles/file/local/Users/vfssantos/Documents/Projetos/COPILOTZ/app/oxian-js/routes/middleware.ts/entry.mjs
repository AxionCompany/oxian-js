function __default(data, context) {
    context.response.headers({
        "x-request-id": context.requestId
    });
    return {
        data: {
            ...data,
            mw: "root"
        }
    };
}
export { __default as default };

//# sourceURL=file:///Users/vfssantos/Documents/Projetos/COPILOTZ/app/oxian-js/routes/middleware.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vVXNlcnMvdmZzc2FudG9zL0RvY3VtZW50cy9Qcm9qZXRvcy9DT1BJTE9UWi9hcHAvb3hpYW4tanMvcm91dGVzL21pZGRsZXdhcmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR2UsbUJBQVUsSUFBVSxFQUFFLE9BQWdCO0lBQ25ELFFBQVEsUUFBUSxDQUFDLE9BQU8sQ0FBQztRQUFFLGdCQUFnQixRQUFRLFNBQVM7SUFBQztJQUM3RCxPQUFPO1FBQUUsTUFBTTtZQUFFLEdBQUcsSUFBSTtZQUFFLElBQUk7UUFBTztJQUFFO0FBQ3pDO0FBSEEsZ0NBR0MifQ==
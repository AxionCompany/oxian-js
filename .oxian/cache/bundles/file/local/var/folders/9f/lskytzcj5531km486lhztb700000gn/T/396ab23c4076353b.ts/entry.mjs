const __default = (defaults)=>({
        ...defaults,
        server: {
            port: 8136
        },
        runtime: {
            ...defaults.runtime || {},
            dependencies: {
                initial: {
                    feature: 'fn'
                }
            }
        }
    });
export { __default as default };

//# sourceURL=file:///var/folders/9f/lskytzcj5531km486lhztb700000gn/T/396ab23c4076353b.ts
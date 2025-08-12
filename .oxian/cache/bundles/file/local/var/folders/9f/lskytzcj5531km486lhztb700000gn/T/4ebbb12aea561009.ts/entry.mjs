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

//# sourceURL=file:///var/folders/9f/lskytzcj5531km486lhztb700000gn/T/4ebbb12aea561009.ts
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vdmFyL2ZvbGRlcnMvOWYvbHNreXR6Y2o1NTMxa200ODZsaHp0YjcwMDAwMGduL1QvNGViYmIxMmFlYTU2MTAwOS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoia0JBQWUsQ0FBQyxXQUFhLENBQUM7UUFBRSxHQUFHLFFBQVE7UUFBRSxRQUFRO1lBQUUsTUFBTTtRQUFLO1FBQUcsU0FBUztZQUFFLEdBQUksU0FBUyxPQUFPLElBQUUsQ0FBQyxDQUFDO1lBQUcsY0FBYztnQkFBRSxTQUFTO29CQUFFLFNBQVM7Z0JBQUs7WUFBRTtRQUFFO0lBQUUsQ0FBQztBQUEzSixnQ0FBNEoifQ==
export declare const AwsCfnWait: {
    create: ({ CustomResource, waitDelay, event, context, callback }: {
        CustomResource: {
            create: (event: any, context: any) => Promise<{
                customResource: () => Promise<{
                    create: () => Promise<any>;
                    update: () => Promise<any>;
                    delete: () => Promise<any>;
                }>;
                wait: (result: any) => Promise<{
                    shouldWait: boolean;
                    result?: any;
                }>;
            }>;
        };
        waitDelay?: any;
        event: any;
        context: any;
        callback: (error?: any, result?: any) => void;
    }) => Promise<any>;
};

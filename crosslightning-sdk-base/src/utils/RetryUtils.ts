

export async function tryWithRetries<T>(func: () => Promise<T>, abortSignal?: AbortSignal, maxRetries?: number, delay?: number, exponential?: boolean): Promise<T> {

    maxRetries = maxRetries || 5;
    delay = delay || 500;
    exponential =  exponential==null ? true : exponential;

    let err = null;

    for(let i=0;i<maxRetries;i++) {
        try {
            const resp: T = await func();
            return resp;
        } catch (e) {
            err = e;
            console.error("tryWithRetries: "+i, e);
        }
        if(abortSignal!=null && abortSignal.aborted) throw new Error("Aborted");
        if(i!==maxRetries-1) {
            await new Promise(resolve => setTimeout(() => resolve, exponential ? delay*Math.pow(2, i) : delay));
        }
    }

    throw err;

}
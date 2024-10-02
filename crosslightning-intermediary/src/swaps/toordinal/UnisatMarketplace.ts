


class UnisatMarketplace {

    readonly url: string;
    readonly apiKey: string;

    constructor(url: string, apiKey: string) {
        this.url = url;
        this.apiKey = apiKey;
    }

    async httpPost<T>(path: string, data: any, abortSignal?: AbortSignal): Promise<T> {
        const response = await fetch(path, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "Authorization": "Bearer " + this.apiKey
            },
            body: JSON.stringify(data)
        });
        if(!response.ok) {
            let text: string;
            try {
                text = await response.text();
            } catch (e) {
                throw new Error("Unisat "+path+" status code: "+response.statusText);
            }
            throw new Error("Unisat "+path+" error: "+text);
        }
        return await response.json();
    }

    

}
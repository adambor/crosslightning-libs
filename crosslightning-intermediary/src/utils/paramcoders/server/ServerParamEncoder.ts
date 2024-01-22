import {Response} from "express";
import {ParamEncoder} from "../ParamEncoder";


export class ServerParamEncoder extends ParamEncoder {

    private response: Response;
    private controller: AbortController;

    constructor(response: Response, statusCode: number) {
        response.header("Content-Type", "application/x-multiple-json");
        let firstWrite = false;
        super((data: Buffer) => {
            if(firstWrite) {
                response.writeHead(statusCode);
                firstWrite = false;
            }
            if(!response.write(data)) {
                return Promise.reject(Error("Write failed"));
            }
            return Promise.resolve();
        }, () => new Promise<void>(resolve => response.end(resolve)));
        this.response = response;
        this.controller = new AbortController();
        this.response.on("close", () => this.controller.abort(new Error("Response stream closed!")));
    }

    async writeParamsAndEnd(params: any): Promise<void> {
        await this.writeParams(params);
        await this.end();
    }

    getAbortSignal(): AbortSignal {
        return this.controller.signal;
    }

}
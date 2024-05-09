import {Response, Request} from "express";
import {IParamWriter} from "../IParamWriter";
import {ParamEncoder} from "../ParamEncoder";
import {LegacyParamEncoder} from "../LegacyParamEncoder";

export class ServerParamEncoder {

    private response: Response;
    private controller: AbortController;

    private paramWriter: IParamWriter;

    constructor(response: Response, statusCode: number, request: Request) {
        const legacy = !request.headers['accept'].includes("application/x-multiple-json");

        let requestEnd = false;
        let responseShouldEnd = false;
        request.on("end", () => {
            requestEnd = true;
            if(responseShouldEnd && requestEnd) response.end();
        });

        const onEnd = () => {
            responseShouldEnd = true;
            if(responseShouldEnd && requestEnd) return new Promise<void>(resolve => response.end(() => resolve()));
            return Promise.resolve();
        };

        const onWrite = (data: Buffer) => {
            if(responseShouldEnd) return Promise.resolve();
            if(firstWrite) {
                response.writeHead(statusCode);
                firstWrite = false;
            }
            return new Promise<void>((resolve, reject) => response.write(data, (error: any) => {
                if(error!=null) {
                    reject(error);
                    return;
                }
                resolve();
            }));
        };

        let firstWrite = false;
        if(legacy) {
            response.header("Content-Type", "application/json");
            this.paramWriter = new LegacyParamEncoder(onWrite, onEnd);
        } else {
            response.header("Content-Type", "application/x-multiple-json");
            this.paramWriter = new ParamEncoder(onWrite, onEnd);
        }

        this.response = response;
        this.controller = new AbortController();
        this.response.on("close", () => this.controller.abort(new Error("Response stream closed!")));
        this.response.on("error", (err: any) => this.controller.abort(err));
    }

    writeParams(params: any): Promise<void> {
        return this.paramWriter.writeParams(params);
    }

    end(): Promise<void> {
        return this.paramWriter.end();
    }

    async writeParamsAndEnd(params: any): Promise<void> {
        await this.writeParams(params);
        await this.end();
    }

    getAbortSignal(): AbortSignal {
        return this.controller.signal;
    }

}
import {Response} from "express";
import {IParamWriter} from "../IParamWriter";
import {ParamEncoder} from "../ParamEncoder";
import {LegacyParamEncoder} from "../LegacyParamEncoder";

export class ServerParamEncoder {

    private response: Response;
    private controller: AbortController;

    private paramWriter: IParamWriter;

    constructor(response: Response, statusCode: number, request: Request) {
        const legacy = !request.headers['accept'].includes("application/x-multiple-json");

        let firstWrite = false;
        if(legacy) {
            response.header("Content-Type", "application/json");
            this.paramWriter = new LegacyParamEncoder((data: Buffer) => {
                if(firstWrite) {
                    response.writeHead(statusCode);
                    firstWrite = false;
                }
                return new Promise((resolve, reject) => response.write(data, (error: any) => {
                    if(error!=null) {
                        reject(error);
                        return;
                    }
                    resolve();
                }));
            }, () => new Promise<void>(resolve => response.end(() => resolve())));
        } else {
            response.header("Content-Type", "application/x-multiple-json");
            this.paramWriter = new ParamEncoder((data: Buffer) => {
                if(firstWrite) {
                    response.writeHead(statusCode);
                    firstWrite = false;
                }
                return new Promise((resolve, reject) => response.write(data, (error: any) => {
                    if(error!=null) {
                        reject(error);
                        return;
                    }
                    resolve();
                }));
            }, () => new Promise<void>(resolve => response.end(() => resolve())));
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
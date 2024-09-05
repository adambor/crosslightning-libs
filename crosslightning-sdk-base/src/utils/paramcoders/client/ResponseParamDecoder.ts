import {ParamDecoder} from "../ParamDecoder";
import {Buffer} from "buffer";
import {RequestSchema, RequestSchemaResultPromise, verifyField} from "../SchemaVerifier";
import {objectMap} from "../../Utils";

export class ResponseParamDecoder<T extends RequestSchema> extends ParamDecoder {

    private readonly reader?: ReadableStreamDefaultReader<Uint8Array>;
    private readonly abortSignal?: AbortSignal;
    private readonly schema: T;

    constructor(resp: Response, schema: T, abortSignal?: AbortSignal) {
        super();

        this.schema = schema;
        this.abortSignal = abortSignal;

        try {
            //Read from stream
            this.reader = resp.body.getReader();
            this.readResponse();
        } catch (e) {
            //Read in one piece
            resp.arrayBuffer().then(respBuffer => {
                super.onData(Buffer.from(respBuffer));
                super.onEnd();
            }).catch(e => {
                super.onError(e);
            });
        }

        if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
            super.onError(abortSignal.reason);
            if(!this.reader.closed) this.reader.cancel(abortSignal.reason);
        });
    }

    /**
     * Keeps reading the response until the reader closes
     * @private
     */
    private async readResponse() {
        while(true) {
            const readResp = await this.reader.read().catch(e => {
                console.error(e);
                return null;
            });
            if(this.abortSignal!=null && this.abortSignal.aborted) return;
            if(readResp==null || readResp.done) {
                super.onEnd();
                return;
            }
            super.onData(Buffer.from(readResp.value));
        }
    }

    /**
     * Returns the promises of the params as defined by the schema
     */
    public getParams(): RequestSchemaResultPromise<T> {
        return objectMap(this.schema, (schemaValue, key) => super.getParam(key).then(value => {
            const result = verifyField(schemaValue, value);
            if(result===undefined) {
                return Promise.reject(new Error("Invalid field value"));
            } else {
                return result;
            }
        })) as any;
    }

}
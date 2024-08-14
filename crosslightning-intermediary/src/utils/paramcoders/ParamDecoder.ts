import {FieldTypeEnum, parseBN, RequestSchema, RequestSchemaResult, verifySchema} from "./SchemaVerifier";
import {IParamReader} from "./IParamReader";


export class ParamDecoder implements IParamReader {

    frameHeader: Buffer = null;
    frameData: Buffer[] = [];
    frameDataLength: number = 0;

    closed: boolean = false;

    params: {
        [key: string]: {
            promise: Promise<any>,
            resolve: (data: any) => void,
            reject: (err: any) => void,
            value: any
        }
    } = {};

    constructor() {

    }

    private onFrameRead(data: Buffer) {
        const obj = JSON.parse(data.toString());
        for(let key in obj) {
            if(this.params[key]==null) {
                this.params[key] = {
                    promise: Promise.resolve(obj[key]),
                    resolve: null,
                    reject: null,
                    value: obj[key]
                };
            } else {
                if(this.params[key].resolve!=null) {
                    this.params[key].resolve(obj[key]);
                    this.params[key].resolve = null;
                    this.params[key].reject = null;
                }
            }
        }
    }

    onData(data: Buffer): void {
        let leavesBuffer = data;
        while(leavesBuffer!=null && leavesBuffer.length>0) {
            if(this.frameHeader==null) {
                if(leavesBuffer.length<=4) {
                    this.frameHeader = leavesBuffer;
                    leavesBuffer = null;
                } else {
                    this.frameHeader = leavesBuffer.subarray(0, 4);
                    leavesBuffer = leavesBuffer.subarray(4);
                }
            } else if(this.frameHeader.length<4) {
                const requiredLen = 4-this.frameHeader.length;
                if(leavesBuffer.length<=requiredLen) {
                    this.frameHeader = Buffer.concat([this.frameHeader, leavesBuffer]);
                    leavesBuffer = null;
                } else {
                    this.frameHeader = Buffer.concat([this.frameHeader, leavesBuffer.subarray(0, requiredLen)]);
                    leavesBuffer = leavesBuffer.subarray(requiredLen);
                }
            }
            if(leavesBuffer==null) continue;
            if(this.frameHeader==null || this.frameHeader.length<4) continue;

            const frameLength = this.frameHeader.readUint32LE();
            const requiredLen = frameLength-this.frameDataLength;

            if(leavesBuffer.length<=requiredLen) {
                this.frameData.push(leavesBuffer);
                this.frameDataLength += leavesBuffer.length;

                leavesBuffer = null;
            } else {
                this.frameData.push(leavesBuffer.subarray(0, requiredLen));
                this.frameDataLength += requiredLen;

                leavesBuffer = leavesBuffer.subarray(requiredLen);
            }

            if(frameLength===this.frameDataLength) {
                //Message read success
                this.onFrameRead(Buffer.concat(this.frameData));
                this.frameHeader = null;
                this.frameData = [];
                this.frameDataLength = 0;
            }
        }
    }

    onEnd(): void {
        for(let key in this.params) {
            if(this.params[key].reject!=null) {
                this.params[key].reject(new Error("EOF before field seen!"));
            }
        }
        this.closed = true;
    }

    onError(e: any): void {
        for(let key in this.params) {
            if(this.params[key].reject!=null) {
                this.params[key].reject(e);
            }
        }
        this.closed = true;
    }

    getParam(key: string): Promise<any> {
        if(this.params[key]==null) {
            if(this.closed) return Promise.reject(new Error("Stream already closed without param received!"));
            let resolve: (data: any) => void;
            let reject: (err: any) => void;
            const promise = new Promise((_resolve, _reject) => {
                resolve = _resolve
                reject = _reject;
            });
            this.params[key] = {
                resolve,
                reject,
                promise,
                value: null
            }
        }
        return this.params[key].promise;
    }

    async getParams<T extends RequestSchema>(schema: T): Promise<RequestSchemaResult<T>> {
        const resultSchema: any = {};
        for(let fieldName in schema) {
            const val: any = await this.getParam(fieldName);
            const type: FieldTypeEnum | RequestSchema | ((val: any) => boolean) = schema[fieldName];
            if(typeof(type)==="function") {
                const result = type(val);
                if(result==null) return null;
                resultSchema[fieldName] = result;
                continue;
            }

            if(val==null && (type as number)>=100) {
                resultSchema[fieldName] = null;
                continue;
            }

            if(type===FieldTypeEnum.Any || type===FieldTypeEnum.AnyOptional) {
                resultSchema[fieldName] = val;
            } else if(type===FieldTypeEnum.Boolean || type===FieldTypeEnum.BooleanOptional) {
                if(typeof(val)!=="boolean") return null;
                resultSchema[fieldName] = val;
            } else if(type===FieldTypeEnum.Number || type===FieldTypeEnum.NumberOptional) {
                if(typeof(val)!=="number") return null;
                if(isNaN(val as number)) return null;
                resultSchema[fieldName] = val;
            } else if(type===FieldTypeEnum.BN || type===FieldTypeEnum.BNOptional) {
                const result = parseBN(val);
                if(result==null) return null;
                resultSchema[fieldName] = result;
            } else if(type===FieldTypeEnum.String || type===FieldTypeEnum.StringOptional) {
                if(typeof(val)!=="string") return null;
                resultSchema[fieldName] = val;
            } else {
                //Probably another request schema
                const result = verifySchema(val, type as RequestSchema);
                if(result==null) return null;
                resultSchema[fieldName] = result;
            }
        }
        return resultSchema;
    }

    getExistingParamsOrNull<T extends RequestSchema>(schema: T): RequestSchemaResult<T> {
        const resultSchema: any = {};
        for(let fieldName in schema) {
            const val: any = this.params[fieldName]?.value;

            if(val==null) {
                resultSchema[fieldName] = null;
                continue;
            }

            const type: FieldTypeEnum | RequestSchema | ((val: any) => boolean) = schema[fieldName];
            if(typeof(type)==="function") {
                const result = type(val);
                if(result==null) return null;
                resultSchema[fieldName] = result;
                continue;
            }

            if(type===FieldTypeEnum.Any || type===FieldTypeEnum.AnyOptional) {
                resultSchema[fieldName] = val;
            } else if(type===FieldTypeEnum.Boolean || type===FieldTypeEnum.BooleanOptional) {
                if(typeof(val)!=="boolean") return null;
                resultSchema[fieldName] = val;
            } else if(type===FieldTypeEnum.Number || type===FieldTypeEnum.NumberOptional) {
                if(typeof(val)!=="number") return null;
                if(isNaN(val as number)) return null;
                resultSchema[fieldName] = val;
            } else if(type===FieldTypeEnum.BN || type===FieldTypeEnum.BNOptional) {
                const result = parseBN(val);
                if(result==null) return null;
                resultSchema[fieldName] = result;
            } else if(type===FieldTypeEnum.String || type===FieldTypeEnum.StringOptional) {
                if(typeof(val)!=="string") return null;
                resultSchema[fieldName] = val;
            } else {
                //Probably another request schema
                const result = verifySchema(val, type as RequestSchema);
                if(result==null) return null;
                resultSchema[fieldName] = result;
            }
        }
        return resultSchema;
    }

}
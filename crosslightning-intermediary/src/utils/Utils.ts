import * as BN from "bn.js";
import {ParamsDictionary, Request, Response} from "express-serve-static-core";
import * as QueryString from "qs";

export function parseBN(str: string | number): BN | null {
    if(str==null) return null;
    if(typeof(str)!=="string" && typeof(str)!=="number") return null;
    try {
        return new BN(str);
    } catch (e) {
        return null;
    }
}

export enum FieldTypeEnum {
    String=0,
    Boolean=1,
    Number=2,
    BN=3
}

export type FieldType<T extends FieldTypeEnum | RequestSchema | ((val: any) => (string | boolean | number | BN | any))> =
    T extends FieldTypeEnum.String ? string :
    T extends FieldTypeEnum.Boolean ? boolean :
    T extends FieldTypeEnum.Number ? number :
    T extends FieldTypeEnum.BN ? BN :
    T extends RequestSchema ? RequestSchemaResult<T> :
    T extends ((val: any) => string) ? string :
    T extends ((val: any) => boolean) ? boolean :
    T extends ((val: any) => number) ? number :
    T extends ((val: any) => BN) ? BN :
    T extends ((val: any) => any) ? any :
        never;

export type RequestSchemaResult<T extends RequestSchema> = {
    [key in keyof T]: FieldType<T[key]>
}

export type RequestSchema = {
    [fieldName: string]: FieldTypeEnum | RequestSchema | ((val: any) => any)
}

export function verifySchema<T extends RequestSchema>(req: any, schema: T): RequestSchemaResult<T> {
    if(req==null) return null;
    const resultSchema: any = {};
    for(let fieldName in schema) {
        const val: any = req[fieldName];
        if(val==null) {
            return null;
        }
        const type: FieldTypeEnum | RequestSchema | ((val: any) => boolean) = schema[fieldName];
        if(typeof(type)==="function") {
            const result = type(val);
            if(result==null) return null;
            resultSchema[fieldName] = result;
        } else if(type===FieldTypeEnum.Boolean) {
            if(typeof(val)!=="boolean") return null;
            resultSchema[fieldName] = val;
        } else if(type===FieldTypeEnum.Number) {
            if(typeof(val)!=="number") return null;
            if(isNaN(val as number)) return null;
            resultSchema[fieldName] = val;
        } else if(type===FieldTypeEnum.BN) {
            const result = parseBN(val);
            if(result==null) return null;
            resultSchema[fieldName] = result;
        } else if(type===FieldTypeEnum.String) {
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

export function expressHandlerWrapper(func: (
    req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
    res: Response<any, Record<string, any>, number>
) => Promise<void>) : ((
    req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
    res: Response<any, Record<string, any>, number>
) => void) {
    return (
        req: Request<ParamsDictionary, any, any, QueryString.ParsedQs, Record<string, any>>,
        res: Response<any, Record<string, any>, number>
    ) => {
        func(req, res).catch(e => {
            console.error(e);
            res.status(500).json({
                msg: "Internal server error"
            });
        });
    }
}

export const HEX_REGEX = /[0-9a-fA-F]+/;
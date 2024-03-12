import {RequestSchema, RequestSchemaResult} from "./SchemaVerifier";

export interface IParamReader {

    getParams<T extends RequestSchema>(schema: T): Promise<RequestSchemaResult<T>>;
    getExistingParamsOrNull<T extends RequestSchema>(schema: T): RequestSchemaResult<T>;

}
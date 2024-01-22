import {RequestSchema, RequestSchemaResult} from "./SchemaVerifier";

export interface IParamReader {

    getParams<T extends RequestSchema>(schema: T): Promise<RequestSchemaResult<T>>;

}
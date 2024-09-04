export interface IParamReader {

    getParam<T>(name: string): Promise<T>;

}
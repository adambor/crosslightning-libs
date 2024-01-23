
export interface IParamWriter {

    end(): Promise<void>;
    writeParams(data: any): Promise<void>;

}


import {IParamWriter} from "./IParamWriter";


export class LegacyParamEncoder implements IParamWriter {

    private readonly writeFN: (data: Buffer) => Promise<void>;
    private readonly endFN: () => Promise<void>;

    private obj = {};

    constructor(write: (data: Buffer) => Promise<void>, end: () => Promise<void>) {
        this.writeFN = write;
        this.endFN = end;
    }

    writeParams(data: any): Promise<void> {
        for(let key in data) {
            if(this.obj[key]==null) this.obj[key] = data[key];
        }
        return Promise.resolve();
    }

    async end(): Promise<void> {
        await this.writeFN(Buffer.from(JSON.stringify(this.obj)));
        await this.endFN();
    }

}
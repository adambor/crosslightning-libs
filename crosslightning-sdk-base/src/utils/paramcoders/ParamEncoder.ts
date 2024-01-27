

export class ParamEncoder {

    private readonly writeFN: (data: Buffer) => Promise<void>;
    private readonly endFN: () => Promise<void>;

    constructor(write: (data: Buffer) => Promise<void>, end: () => Promise<void>) {
        this.writeFN = write;
        this.endFN = end;
    }

    writeParams(data: any): Promise<void> {
        const serialized: Buffer = Buffer.from(JSON.stringify(data));

        const frameLengthBuffer = Buffer.alloc(4);
        frameLengthBuffer.writeUint32LE(serialized.length);

        return this.writeFN(Buffer.concat([
            frameLengthBuffer,
            serialized
        ]));
    }

    end(): Promise<void> {
        return this.endFN();
    }

}
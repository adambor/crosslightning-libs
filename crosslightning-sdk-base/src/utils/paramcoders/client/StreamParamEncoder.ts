import {ParamEncoder} from "../ParamEncoder";
import {Buffer} from "buffer";


export class StreamParamEncoder extends ParamEncoder {

    private readonly stream: TransformStream<Buffer>;

    constructor() {
        let stream = new TransformStream<Buffer>();
        let writeStream = stream.writable.getWriter();
        super(writeStream.write.bind(writeStream), () => {
            if(writeStream.closed) return Promise.resolve();
            return writeStream.close()
        });
        this.stream = stream;
    }

    /**
     * Returns the readable stream to be passed to the fetch API
     */
    getReadableStream(): ReadableStream<Buffer> {
        return this.stream.readable;
    }

}
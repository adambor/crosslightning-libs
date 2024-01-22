import {ParamEncoder} from "../ParamEncoder";
import {IParamReader} from "../IParamReader";
import {RequestSchema, verifySchema} from "../SchemaVerifier";
import {ParamDecoder} from "../ParamDecoder";


async function readResponse(reader: ReadableStreamDefaultReader, inputStream: ParamDecoder) {
    while(true) {
        const {value, done} = await reader.read();
        if(done) {
            inputStream.onEnd();
            break;
        }
        inputStream.onData(Buffer.from(value));
    }
}

export function streamingFetch(input: RequestInfo | URL, init?: RequestInit): {
    response: Promise<Response & { inputStream: IParamReader }>,
    outputStream?: ParamEncoder
} {
    let outputStream: ParamEncoder;
    if(init.method==="POST" && init.body==null) {
        let stream = new TransformStream();
        let writeStream = stream.writable.getWriter();
        init.body = stream.readable;
        if(init.headers==null) init.headers = {};
        init.headers['content-type'] = "application/x-multiple-json";
        (init as any).duplex = "half";

        outputStream = new ParamEncoder(writeStream.write.bind(writeStream), writeStream.close.bind(writeStream));

        if(init.signal!=null) init.signal.addEventListener("abort", () => {
            if(!writeStream.closed) writeStream.close();
        });
    }

    return {
        response: fetch(input, init).then(resp => {
            if(resp.status!==200) {
                return resp;
            }

            if(resp.headers.get("content-type")!=="application/x-multiple-json") {
                return resp.json().then(body => {
                    (resp as any).inputStream = {
                        getParams: <T extends RequestSchema>(schema: T) => {
                            return Promise.resolve(verifySchema(body, schema));
                        }
                    };
                    return resp;
                });
            } else {
                const inputStream = new ParamDecoder();
                const reader = resp.body.getReader();

                if(init.signal!=null) init.signal.addEventListener("abort", (reason) => {
                    if(!reader.closed) reader.cancel(reason);
                });

                readResponse(reader, inputStream);

                (resp as any).inputStream = inputStream;
                return resp;
            }
        }) as any,
        outputStream
    };
}
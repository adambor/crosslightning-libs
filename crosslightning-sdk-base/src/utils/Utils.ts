import {Buffer} from "buffer";

export async function sha256Buffer(buff: Buffer | string): Promise<Buffer> {
    if(typeof(buff)==="string") buff = Buffer.from(buff);
    const result = await crypto.subtle.digest("sha-256", buff);
    return Buffer.from(result, 0, result.byteLength);
}

export async function randomBytesBuffer(length: number): Promise<Buffer> {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Buffer.from(array);
}

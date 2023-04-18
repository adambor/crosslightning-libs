import * as fs from "fs/promises";
import {ISwapNonce} from "crosslightning-base";

const NONCE_FILENAME = "/nonce.json";

export class SwapNonce implements ISwapNonce {

    private nonces: {
        [token: string]: {
            nonce: number,
            claimNonce: number
        }
    };

    private readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
    }

    async init() {
        try {
            await fs.mkdir(this.directory);
        } catch (e) {}

        try {
            const txt = await fs.readFile(this.directory+NONCE_FILENAME);
            this.nonces = JSON.parse(txt.toString());
        } catch (e) {
            this.nonces = {};
        }
    }

    async saveNonce(token: string, _nonce: number) {
        if(this.nonces[token]==null) {
            this.nonces[token] = {
                claimNonce: 0,
                nonce: 0
            }
        }
        this.nonces[token].nonce = _nonce;
        await fs.writeFile(this.directory+NONCE_FILENAME, JSON.stringify(this.nonces));
    }

    async saveClaimNonce(token: string, _nonce: number) {
        if(this.nonces[token]==null) {
            this.nonces[token] = {
                claimNonce: 0,
                nonce: 0
            }
        }
        this.nonces[token].claimNonce = _nonce;
        await fs.writeFile(this.directory+NONCE_FILENAME, JSON.stringify(this.nonces));
    }

    getNonce(token: string): number {
        return this.nonces[token]?.nonce || 0;
    }

    getClaimNonce(token: string): number {
        return this.nonces[token]?.claimNonce || 0;
    }

}

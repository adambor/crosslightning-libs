import {SolanaModule} from "../SolanaModule";
import {createHash} from "crypto";
import {sign} from "tweetnacl";
import {PublicKey} from "@solana/web3.js";

export class SolanaSignatures extends SolanaModule {

    ///////////////////
    //// Data signatures
    getDataSignature(data: Buffer): Promise<string> {
        if(this.provider.signer==null) throw new Error("Unsupported");
        const buff = createHash("sha256").update(data).digest();
        const signature = sign.detached(buff, this.provider.signer.secretKey);

        return Promise.resolve(Buffer.from(signature).toString("hex"));
    }

    isValidDataSignature(data: Buffer, signature: string, publicKey: string): Promise<boolean> {
        const hash = createHash("sha256").update(data).digest();
        return Promise.resolve(sign.detached.verify(hash, Buffer.from(signature, "hex"), new PublicKey(publicKey).toBuffer()));
    }

}